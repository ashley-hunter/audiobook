/* Bedtime - the two lists on the home screen, drawn with Preact.
 *
 * Everything else on the screen is still built by hand in app.js. These two are
 * the ones that were rebuilt from scratch on every change - a heart tap threw
 * away every row in the library and made them all again. Preact keeps the
 * nodes and touches only what actually differs.
 *
 * Preact and htm are vendored as plain scripts: no build step, and both parse
 * on Safari 12, which is the floor. The markup here is deliberately the same
 * as what the hand-written version produced, classes and all.
 */
window.App = window.App || {};

App.lists = (function () {
  'use strict';

  var html = htm.bind(preact.h);

  /* The cover is painted rather than described: the art is a Blob URL fetched
   * from IndexedDB, so it arrives after the render. A ref fresh on each render
   * repaints a story whose art has since turned up.
   */
  function cover(className, story) {
    return html`<span class=${'cover ' + className} ref=${function (node) {
      if (node) App.ui.paintCover(node, story);
    }}></span>`;
  }

  function row(story, on) {
    function heart(event) {
      event.stopPropagation();
      on.fav(story.id);
    }
    return html`
      <div class=${'row' + (story.missing ? ' is-missing' : '')} key=${story.id}>
        <button class="row-open" type="button" onClick=${function () { on.open(story.id); }}>
          ${cover('cover-row', story)}
          <span class="row-text">
            <span class="row-title">${story.title}</span>
            <span class="row-meta">${on.meta(story)}</span>
          </span>
        </button>
        <button class=${'row-heart' + (story.fav ? ' is-on' : '')} type="button"
                aria-label=${story.fav ? 'Unheart this story' : 'Heart this story'}
                onClick=${heart}>\u2665</button>
        ${story.missing ? null : html`
          <button class="row-more" type="button" aria-label=${'More for ' + story.title}
                  onClick=${function () { on.menu(story); }}>\u22ef</button>`}
      </div>`;
  }

  function pick(story, index, on) {
    return html`
      <div class="pick" key=${story.id}>
        <button class="pick-btn" type="button" onClick=${function () { on.open(story.id); }}>
          <span class="pick-frame">
            ${cover('pick-cover', story)}
            <span class="pick-no">${String(index + 1)}</span>
          </span>
          <span class="pick-title">${story.title}</span>
          <span class="pick-mins">${App.ui.minutes(story.len)}</span>
        </button>
      </div>`;
  }

  function rows(host, list, on) {
    preact.render(html`<${preact.Fragment}>
      ${list.map(function (story) { return row(story, on); })}
    <//>`, host);
  }

  function picks(host, list, on) {
    preact.render(html`<${preact.Fragment}>
      ${list.map(function (story, index) { return pick(story, index, on); })}
    <//>`, host);
  }

  return { rows: rows, picks: picks };
})();
