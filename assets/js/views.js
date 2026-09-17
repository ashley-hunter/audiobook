/* Bedtime - everything on screen that is built from data, drawn with Preact.
 *
 * These lists used to be built by hand and thrown away whole on every change:
 * a heart tap remade every row in the library. Preact keeps the nodes and
 * touches only what differs, which is both less work for an old phone and the
 * reason a drag or a hold in progress is no longer lost when something
 * re-renders underneath it.
 *
 * Preact and htm are vendored as plain scripts: no build step, and both parse
 * on Safari 12, which is the floor. What is drawn here is deliberately the
 * same markup the hand-written version produced, classes and all - `npm run
 * parity` compares the two and will say so if that ever stops being true.
 *
 * The player is not here. It is updated field by field so the once-a-second
 * tick never rebuilds a node or restarts the starfield.
 */
window.App = window.App || {};

App.views = (function () {
  'use strict';

  var html = htm.bind(preact.h);
  var ui = App.ui;

  function draw(host, tree) {
    preact.render(html`<${preact.Fragment}>${tree}<//>`, host);
  }

  /* The cover is painted rather than described: the art is a Blob URL read out
   * of IndexedDB, so it arrives after the render. A ref fresh on each render
   * repaints a story whose art has since turned up.
   */
  function cover(className, story) {
    return html`<span class=${'cover ' + className} ref=${function (node) {
      if (node) ui.paintCover(node, story);
    }}></span>`;
  }

  /* ------------------------------------------------------ the library list */

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
                onClick=${heart}>♥</button>
        ${story.missing ? null : html`
          <button class="row-more" type="button" aria-label=${'More for ' + story.title}
                  onClick=${function () { on.menu(story); }}>⋯</button>`}
      </div>`;
  }

  function rows(host, list, on) {
    draw(host, list.map(function (story) { return row(story, on); }));
  }

  /* ------------------------------------------------------- tonight's picks */

  function pick(story, index, on) {
    return html`
      <div class="pick" key=${story.id}>
        <button class="pick-btn" type="button" onClick=${function () { on.open(story.id); }}>
          <span class="pick-frame">
            ${cover('pick-cover', story)}
            <span class="pick-no">${String(index + 1)}</span>
          </span>
          <span class="pick-title">${story.title}</span>
          <span class="pick-mins">${ui.minutes(story.len)}</span>
        </button>
      </div>`;
  }

  function picks(host, list, on) {
    draw(host, list.map(function (story, index) { return pick(story, index, on); }));
  }

  /* ------------------------------------------------------------- the moods */

  function moods(host, names, current, on) {
    draw(host, names.map(function (name) {
      return html`
        <button class=${'mood' + (current === name ? ' is-on' : '')} type="button" key=${name}
                onClick=${function () { on.pick(name); }}>${name}</button>`;
    }));
  }

  /* ------------------------------------------------- the empty library */

  function emptyState(host, hiddenByParent, on) {
    // Built as a list rather than one template: a multi-line template leaves
    // whitespace text nodes between the elements, which the hand-written
    // version did not have.
    draw(host, [
      html`<p class="empty-title display display-sm">${hiddenByParent ? 'Stories are hidden' : 'No stories yet'}</p>`,
      // The "Show in the library" switch lives on the Add screen, so the same
      // button is the way back from here as well as the way to add more.
      html`<p>${hiddenByParent
        ? 'Turn "Show in the library" back on from the Add stories screen.'
        : 'Bring in audio you already own. Files are copied into this app and stay on this phone.'}</p>`,
      html`<button class="empty-add" type="button" onClick=${on.add}><span class="plus">+</span>Add stories</button>`
    ]);
  }

  /* ------------------------------------------------------ the sleep timer */

  function timerOptions(host, model, on) {
    var minuteChips = model.minutes.map(function (m) {
      return html`
        <button class=${'timer-opt' + (model.chosenMinutes === m ? ' is-on' : '')} type="button"
                key=${'m' + m} onClick=${function () { on.minutes(m); }}>${String(m)}</button>`;
    });

    // The keypad on iOS has no return key, so the value is taken on `change`,
    // which fires when its Done button closes the keyboard.
    function typed(event) {
      var input = event.currentTarget;
      var minutes = parseInt(input.value, 10);
      if (!(minutes >= 1 && minutes <= model.maxMinutes)) {
        ui.toast('Pick between 1 and ' + model.maxMinutes + ' minutes.');
        input.value = model.custom ? String(model.custom) : '';
        return;
      }
      on.minutes(minutes);
    }

    var custom = html`
      <label class=${'timer-opt timer-custom' + (model.custom ? ' is-on' : '')} key="custom">
        <input type="number" min="1" max=${String(model.maxMinutes)} step="1"
               pattern="[0-9]*" inputmode="numeric" aria-label="Other number of minutes"
               placeholder="Other" value=${model.custom ? String(model.custom) : ''}
               onChange=${typed} />
      </label>`;

    var storyChips = [];
    for (var n = 1; n <= model.mostStories; n++) {
      storyChips.push(storyChip(n, model.chosenStories === n, on));
    }

    draw(host, html`
      <${preact.Fragment}>
        <p class="timer-group">Minutes</p>
        <div class="timer-row">${minuteChips}${custom}</div>
        <p class="timer-group">Stories</p>
        <div class="timer-row">${storyChips}</div>
        ${model.mostStories === 1 ? html`
          <p class="timer-hint">Line up more of tonight’s picks to play several in a row.</p>` : null}
      <//>`);
  }

  function storyChip(count, on, handlers) {
    return html`
      <button class=${'timer-opt' + (on ? ' is-on' : '')} type="button" key=${'s' + count}
              onClick=${function () { handlers.stories(count); }}>
        ${count === 1 ? 'This one' : String(count)}
      </button>`;
  }

  /* ------------------------------------------------------ parent controls */

  function toggles(host, list, on) {
    draw(host, list.map(function (item) {
      return html`
        <button class="card-row" type="button" key=${item.key}
                onClick=${function () { on.toggle(item.key, !item.on); }}>
          ${item.label}
          <span class=${'switch' + (item.on ? ' is-on' : '')}><span class="knob"></span></span>
        </button>`;
    }));
  }

  function storedList(host, list, on) {
    draw(host, list.map(function (story) {
      return html`
        <div class="stored" key=${story.id}>
          <div class="stored-text">
            <p class="stored-name">${story.title}</p>
            <p class=${'stored-meta' + (story.missing ? ' is-missing' : '')}>
              ${story.missing ? 'Audio was cleared by iOS'
                              : ui.bytes(story.size) + ' · ' + ui.minutes(story.len)}
            </p>
          </div>
          <button class="remove" type="button"
                  onClick=${function () { on.remove(story); }}>Remove</button>
        </div>`;
    }));
  }

  /* --------------------------------------------------- a story's ⋯ menu */

  function menuActions(host, items) {
    draw(host, items.map(function (item, index) {
      return html`
        <button class="confirm-btn" type="button" key=${index}
                onClick=${item.run}>${item.label}</button>`;
    }));
  }

  /* --------------------------------------------------------- import rows */

  function imports(host, list, on) {
    draw(host, list.map(function (item) {
      function chooseArt(event) {
        var input = event.currentTarget;
        var image = input.files && input.files[0];
        input.value = '';
        if (image) on.art(item, image);
      }
      return html`
        <div class=${'import' + (item.state ? ' is-' + item.state : '')} key=${item.key}>
          <label class="import-art" style=${'background-image: ' + item.art}>
            <span class="art-label">${item.artLabel}</span>
            <input type="file" accept="image/*" onChange=${chooseArt} />
          </label>
          <div class="import-text">
            <p class="import-name">${item.name}</p>
            <div class="import-bar"><span style=${'width: ' + item.percent + '%'}></span></div>
          </div>
          <div class="import-status">${item.status}</div>
        </div>`;
    }));
  }

  return {
    rows: rows,
    picks: picks,
    moods: moods,
    emptyState: emptyState,
    timerOptions: timerOptions,
    toggles: toggles,
    storedList: storedList,
    menuActions: menuActions,
    imports: imports
  };
})();
