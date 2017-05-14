import _ from 'lodash';
import L from 'leaflet';

import './list.scss';
import template from './list.html';

import barcode from './../../../images/barcode.svg';

const ListComponent = { controller, template };

function controller($scope, $state, $stateParams, $timeout, $window, langService, leafletData, localStorageService, mapService, WikiService, wikidata) {
  const vm = this;
  const icon = mapService.getMapIcon();
  const id = $stateParams.id.includes('Q') ? $stateParams.id : `Q${$stateParams.id}`;
  let langs = langService.getUserLanguages();

  vm.dict = {
    instances: [
      { label: 'Art', value: 'Q838948' },
      { label: 'Cemetery', value: 'Q39614' },
      { label: 'Place of worship', value: 'Q1370598' },
      { label: 'Residential building', value: 'Q11755880' },
    ],
  };
  vm.filter = angular.extend({ heritage: 1 }, $stateParams);

  vm.image = [];
  vm.lang = langs[0];
  vm.list = null;
  vm.listParams = {};
  vm.loading = 'data';
  vm.map = null;
  vm.mobile = {};
  vm.stats = null;

  vm.filterMap = filterMap;
  vm.showMyMap = () => { vm.contentScrolled = true; };
  vm.showMyList = () => { vm.contentScrolled = false; };

  if (!id || id === 'Q') {
    vm.loading = false;
    return;
  }

  init();

  function createStats(list) {
    const stats = {
      images: 0,
      architect: [],
      style: [],
      instance: [],
    };
    list.forEach((element) => {
      if (element.image) { stats.images += 1; }
      ['architect', 'style', 'instance'].forEach((param) => {
        if (element[param].length) {
          Array.prototype.push.apply(stats[param], element[param]);
          stats[param] = _.uniqBy(stats[param], 'value_id');
        }
      });
    });
    console.log(stats);
    return stats;
  }

  function getImage(image) {
    WikiService.getImage(image).then((response) => {
      vm.image.push(response.imageinfo);
    });
  }

  function getList() {
    const heritageOptions = ['MINUS { ?item p:P1435 ?monument . }', '?item p:P1435 ?monument .'];
    const imageOptions = ['MINUS { ?item wdt:P18 ?image . }', '?item wdt:P18 ?image .'];

    const heritage = heritageOptions[vm.filter.heritage] || 'OPTIONAL { ?item p:P1435 ?monument . }';
    const image = imageOptions[vm.filter.image] || 'OPTIONAL { ?item wdt:P18 ?image . }';

    return wikidata.getSPARQL(`SELECT DISTINCT ?item ?itemLabel (SAMPLE(?admin) AS ?admin) (SAMPLE(?adminLabel) AS ?adminLabel)
    (SAMPLE(?coord) AS ?coord) (SAMPLE(?image) AS ?image) ?instance ?instanceLabel ?style ?styleLabel ?architect ?architectLabel
    WHERE {
      hint:Query hint:optimizer "None" .
      ?admin wdt:P131* wd:${id} .
      ?item wdt:P131 ?admin .
      ?item wdt:P625 ?coord .

      ${heritage}
      ${image}
      ${vm.filter.instance ? `?item wdt:P31 ?instance . ?instance wdt:P279* wd:${vm.filter.instance} .` : 'OPTIONAL { ?item wdt:P31?instance }'}

      OPTIONAL { ?admin rdfs:label ?adminLabel . FILTER(LANG(?adminLabel) IN ("${langs[0].code}")) }
      OPTIONAL { ?item wdt:P149 ?style }
      OPTIONAL { ?item wdt:P84 ?architect }
      # ?item wdt:P84 ?architect . ?item wdt:P84 wd:Q41508
      SERVICE wikibase:label { bd:serviceParam wikibase:language "${langs.map(lang => lang.code).join(',')}" }
    }
    GROUP BY ?item ?itemLabel ?instance ?instanceLabel ?style ?styleLabel ?architect ?architectLabel
    ORDER BY ?itemLabel`);
  }

  function getPlace() {
    return wikidata.getById(id).then((data) => {
      const first = Object.keys(data)[0];
      vm.place = data[first];

      const claims = vm.place.claims;
      if (vm.place.claims.P41) {
        claims.P41.values.forEach(image => getImage(image.value));
      } else if (vm.place.claims.P94) {
        claims.P94.values.forEach(image => getImage(image.value));
      }
      if (vm.place.claims.P17) {
        const country = claims.P17.values[0];
        const countryLanguages = langService.getNativeLanguages(country.value_id);

        if (!countryLanguages) { return false; }
        langs = langs.concat(countryLanguages.map(lang => ({ code: lang })));
      }
      return true;
    });
  }

  function filterMap() {
    $state.transitionTo('main.list', vm.filter, { notify: false });
    vm.loading = 'map';
    getList()
      .then(data => parseList(data))
      .then((list) => {
        vm.stats = createStats(list);
        vm.list = list.slice(0, 2000);
        loadMap(vm.list);
      });
  }

  function init() {
    if (!langs) { return; }
    vm.mobile.fullHeader = true;

    getPlace()
      .then(() => {
        let center = { lat: 49.4967, lng: 12.4805, zoom: 4 };
        if (vm.place.claims.P625) {
          const coords = vm.place.claims.P625.values[0].value;
          center = { lat: coords.latitude, lng: coords.longitude, zoom: 7 };
        }
        return $timeout(() => {
          vm.map = mapService.getMapInstance({ center });
        });
      })
      .then(() => setTitle())
      .then(() => getList())
      .then(data => parseList(data))
      .then((list) => {
        vm.stats = createStats(list);
        vm.list = list.slice(0, 2000);
        vm.loading = 'map';
        loadMap(vm.list, { fitMap: true });

        $scope.$on('leafletDirectiveMarker.mouseover', showPopup);
        $scope.$on('leafletDirectiveMarker.click', showPopup);
      });
  }

  function loadMap(list, options) {
    const bounds = [];
    const markers = {};

    list
      .filter(element => element.coord)
      .forEach((element) => {
        const identifier = element.name.value_id;
        markers[identifier] = {
          data: element,
          lat: element.coord.lat,
          lng: element.coord.lng,
          layer: 'monuments',
          icon,
        };
        bounds.push(element.coord);
      });

    vm.map.markers = markers;

    if (options && options.fitMap) {
      $timeout(() => {
        leafletData.getMap().then((map) => {
          if (bounds.length) {
            map.fitBounds(bounds, { padding: [25, 25] });
          }
          vm.loading = false;
        });
      });
    } else {
      vm.loading = false;
    }
  }

  function parseList(data) {
    const list = data.map((element) => {
      const obj = {
        name: {
          value_id: URItoID(element.item.value),
          value: element.itemLabel.value,
        },
        admin: {
          value_id: URItoID(element.admin.value),
          value: element.adminLabel ? element.adminLabel.value : URItoID(element.admin.value),
        },
        architect: [],
        style: [],
        instance: [],
      };
      if (element.coord.value) {
        const coord = element.coord.value.replace('Point(', '').replace(')', '').split(' ');
        obj.coord = { lat: parseFloat(coord[1]), lng: parseFloat(coord[0]) };
      }
      if (element.image) {
        const image = `${element.image.value.replace('wiki/Special:FilePath', 'w/index.php?title=Special:Redirect/file')}&width=120`;
        obj.image = image;
      }
      if (element.architect) {
        obj.architect = [{
          value_id: URItoID(element.architect.value),
          value: element.architectLabel.value,
        }];
      }
      if (element.style) {
        obj.style = [{
          value_id: URItoID(element.style.value),
          value: element.styleLabel.value,
        }];
      }
      if (element.instance) {
        obj.instance = [{
          value_id: URItoID(element.instance.value),
          value: element.instanceLabel.value,
        }];
      }
      return obj;
    }).filter((element, index, array) => {
      const firstIndex = array.findIndex(t => t.name.value_id === element.name.value_id);
      if (firstIndex !== index) {
        const firstElement = array[firstIndex];
        ['architect', 'style', 'instance'].forEach((param) => {
          if (element[param].length) {
            firstElement[param].push(_.first(element[param]));
            firstElement[param] = _.uniqBy(firstElement[param], 'value_id');
          }
        });
        return false;
      }
      return true;
    });
    return list;
  }

  function setTitle() {
    const title = vm.place.labels[vm.lang.code] || vm.place.labels.en || vm.place.id;
    $window.document.title = `${title} – Monumental`;
  }

  function showPopup(event, marker) {
    if (marker.leafletEvent.type === 'click') {
      const item = vm.list.filter(element => element.name.value_id === marker.model.data.name.value_id)[0];
      vm.highlighted = item.name.value_id;
      vm.topIndex = vm.list.indexOf(item);
    }

    if (marker.leafletObject.getPopup() && marker.leafletObject.isPopupOpen()) {
      return;
    }
    if (marker.leafletObject.getPopup() && !marker.leafletObject.isPopupOpen()) {
      marker.leafletObject.openPopup();
      return;
    }

    const data = marker.model.data;
    const text = `<md-list-item class="md-2-line"
                    ui-sref="main.object({id: ${data.name.value_id.substring(1)}})">
                <div class="list__image" layout="row" layout-align="center center" ng-if="${!!data.image}">
                  <img ng-src="{{::'${data.image}'}}">
                </div>
                <div class="md-list-item-text" layout="column">
                  <p>${data.name.value}</p>
                  <p class="muted">${data.admin.value}</p>
                </div>
              </md-list-item>`;

    const popup = L.popup({ autoPan: false }).setContent(text);
    marker.leafletObject.bindPopup(popup);
    marker.leafletObject.openPopup();
  }

  function URItoID(uri) {
    return uri.substring(uri.indexOf('/Q') + 1);
  }
}

export default () => {
  angular
    .module('monumental')
    .component('moList', ListComponent);
};
