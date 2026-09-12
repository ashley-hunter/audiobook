/* Bedtime - small DOM and formatting helpers shared by app.js. */
window.App = window.App || {};

App.ui = (function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function show(node, visible) {
    if (node) node.hidden = !visible;
  }

  function toggleClass(node, className, on) {
    if (!node) return;
    var classes = node.className.split(/\s+/);
    var out = [];
    for (var i = 0; i < classes.length; i++) {
      if (classes[i] && classes[i] !== className) out.push(classes[i]);
    }
    if (on) out.push(className);
    node.className = out.join(' ');
  }

  function text(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
  }

  /* ------------------------------------------------------------ formatting */

  function clock(seconds) {
    var total = Math.max(0, Math.floor(seconds || 0));
    var s = total % 60;
    var m = Math.floor(total / 60) % 60;
    var h = Math.floor(total / 3600);
    var ss = s < 10 ? '0' + s : String(s);
    if (h > 0) {
      var mm = m < 10 ? '0' + m : String(m);
      return h + ':' + mm + ':' + ss;
    }
    return m + ':' + ss;
  }

  function minutes(seconds) {
    if (!seconds) return 'Unknown length';
    var mins = Math.round(seconds / 60);
    if (mins < 60) return mins + ' min';
    var h = Math.floor(mins / 60);
    var rest = mins % 60;
    return rest ? h + ' h ' + rest + ' m' : h + ' h';
  }

  function bytes(size) {
    if (!size) return '0 MB';
    if (size < 1024 * 1024) return Math.max(1, Math.round(size / 1024)) + ' KB';
    var mb = size / (1024 * 1024);
    if (mb < 1024) return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
    return (mb / 1024).toFixed(1) + ' GB';
  }

  /* ---------------------------------------------------------------- covers */

  // The design's striped covers. The palette is taken straight from the
  // prototype so generated covers sit in the same night-sky family.
  var COVERS = [
    ['#2A2F5E', '#232850'],
    ['#3B3050', '#332946'],
    ['#2A4A4A', '#244040'],
    ['#2C3C5A', '#26344E'],
    ['#33305C', '#2B2950'],
    ['#4A3A2E', '#403227'],
    ['#3C3566', '#342E5C']
  ];
  var COVER_LIGHT = ['#DCD8EE', '#D3CEE9'];

  function stripes(seed, light) {
    var pair = light ? COVER_LIGHT : COVERS[Math.abs(seed || 0) % COVERS.length];
    var step = light ? 6 : 7;
    return 'repeating-linear-gradient(135deg, ' + pair[0] + ' 0px, ' + pair[0] + ' ' + step + 'px, ' +
           pair[1] + ' ' + step + 'px, ' + pair[1] + ' ' + (step * 2) + 'px)';
  }

  // Paints a cover onto a node: the real artwork when there is one, stripes
  // otherwise. Returns immediately and fills the art in when it loads.
  function paintCover(node, story, light) {
    if (!node) return;
    node.style.backgroundImage = stripes(story.hue || 0, light);
    if (!story.hasArt) return;
    App.media.artUrl(story.id).then(function (url) {
      if (url && node.parentNode) node.style.backgroundImage = 'url("' + url + '")';
    });
  }

  /* ----------------------------------------------------------------- toast */

  var toastTimer = null;

  function toast(message) {
    var node = $('toast');
    if (!node) return;
    node.textContent = message;
    toggleClass(node, 'is-on', true);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toggleClass(node, 'is-on', false); }, 3600);
  }

  /* ----------------------------------------------------------------- rings */

  // Sets an SVG progress ring from a 0..1 fraction.
  function ring(node, fraction) {
    if (!node) return;
    var circumference = parseFloat(node.getAttribute('r')) * 2 * Math.PI;
    var clamped = Math.max(0, Math.min(1, fraction || 0));
    node.style.strokeDasharray = circumference.toFixed(2);
    node.style.strokeDashoffset = (circumference * (1 - clamped)).toFixed(2);
  }

  return {
    $: $,
    el: el,
    clear: clear,
    show: show,
    toggleClass: toggleClass,
    text: text,
    clock: clock,
    minutes: minutes,
    bytes: bytes,
    stripes: stripes,
    paintCover: paintCover,
    toast: toast,
    ring: ring
  };
})();
