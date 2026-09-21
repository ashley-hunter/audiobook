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
window.App = window.App || ({} as typeof App);

App.views = (function (): ViewsModule {
  'use strict';

  var html = htm.bind(preact.h);
  var ui = App.ui;

  function draw(host: HTMLElement, tree: any): void {
    preact.render(html`<${preact.Fragment}>${tree}<//>`, host);
  }

  /* The cover is painted rather than described: the art is a Blob URL read out
   * of IndexedDB, so it arrives after the render. A ref fresh on each render
   * repaints a story whose art has since turned up.
   */
  function cover(className: string, story: Story): any {
    return html`<span class=${'cover ' + className} ref=${function (node) {
      if (node) ui.paintCover(node, story);
    }}></span>`;
  }

  /* ------------------------------------------------------ the library list */

  function row(story: Story, on: any): any {
    function heart(event: Event): void {
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

  function rows(host: HTMLElement, list: Story[], on: any): void {
    draw(host, list.map(function (story) { return row(story, on); }));
  }

  /* ------------------------------------------------------- tonight's picks */

  function pick(story: Story, index: number, on: any): any {
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

  function picks(host: HTMLElement, list: Story[], on: any): void {
    draw(host, list.map(function (story, index) { return pick(story, index, on); }));
  }

  /* ------------------------------------------------------------- the moods */

  function moods(host: HTMLElement, names: string[], current: string, on: any): void {
    draw(host, names.map(function (name) {
      return html`
        <button class=${'mood' + (current === name ? ' is-on' : '')} type="button" key=${name}
                onClick=${function () { on.pick(name); }}>${name}</button>`;
    }));
  }

  /* ------------------------------------------------- the empty library */

  function emptyState(host: HTMLElement, hiddenByParent: boolean, on: any): void {
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

  function timerOptions(host: HTMLElement, model: any, on: any): void {
    var minuteChips = model.minutes.map(function (m) {
      return html`
        <button class=${'timer-opt' + (model.chosenMinutes === m ? ' is-on' : '')} type="button"
                key=${'m' + m} onClick=${function () { on.minutes(m); }}>${String(m)}</button>`;
    });

    // The keypad on iOS has no return key, so the value is taken on `change`,
    // which fires when its Done button closes the keyboard.
    function typed(event: Event): void {
      var input = event.currentTarget as HTMLInputElement;
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

    var storyChips: any[] = [];
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

  function storyChip(count: number, on: boolean, handlers: any): any {
    return html`
      <button class=${'timer-opt' + (on ? ' is-on' : '')} type="button" key=${'s' + count}
              onClick=${function () { handlers.stories(count); }}>
        ${count === 1 ? 'This one' : String(count)}
      </button>`;
  }

  /* ------------------------------------------------------ parent controls */

  function toggles(host: HTMLElement, list: any[], on: any): void {
    draw(host, list.map(function (item: any) {
      return html`
        <button class="card-row" type="button" key=${item.key}
                onClick=${function () { on.toggle(item.key, !item.on); }}>
          ${item.label}
          <span class=${'switch' + (item.on ? ' is-on' : '')}><span class="knob"></span></span>
        </button>`;
    }));
  }

  function storedList(host: HTMLElement, list: Story[], on: any): void {
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

  function menuActions(host: HTMLElement, items: any[]): void {
    draw(host, items.map(function (item: any, index: number) {
      return html`
        <button class="confirm-btn" type="button" key=${index}
                onClick=${item.run}>${item.label}</button>`;
    }));
  }

  /* --------------------------------------------------------- import rows */

  function imports(host: HTMLElement, list: ImportRow[], on: any): void {
    draw(host, list.map(function (item) {
      function chooseArt(event: Event): void {
        var input = event.currentTarget as HTMLInputElement;
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

  /* ------------------------------------------------------------- an update */

  // The night sky's own mark: a four-pointed star, drawn rather than typed.
  var STAR = 'M12 1.5c.5 5.2 4.3 9 9.5 9.5-5.2.5-9 4.3-9.5 9.5-.5-5.2-4.3-9-9.5-9.5 5.2-.5 9-4.3 9.5-9.5z';

  /* A new release waiting to be taken, on the home screen. It announces itself
   * as a status rather than asking for attention: nothing is wrong, and the
   * update will happen on its own the next time the app is put away.
   */
  function updateBanner(host: HTMLElement, model: { show: boolean }, on: any): void {
    if (!model.show) {
      draw(host, null);
      return;
    }
    draw(host, html`
      <section class="update" role="status" aria-live="polite">
        <div class="update-body">
          <svg class="update-star" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d=${STAR}></path></svg>
          <div class="update-text">
            <p class="update-title">A new version is ready</p>
            <p class="update-sub">It takes a moment, and every story keeps its place.</p>
          </div>
        </div>
        <div class="update-actions">
          <button class="update-later" type="button" onClick=${on.later}>Later</button>
          <button class="update-go" type="button" onClick=${on.apply}>Update</button>
        </div>
      </section>`);
  }

  /* The same, in parent controls, where it can also be asked for: a grown-up
   * who put the card off, or who wants to know the app is current. */
  function updateRow(host: HTMLElement, model: { state: string }, on: any): void {
    var state = model.state;
    if (state === 'checking') {
      draw(host, html`<div class="card-row update-row">Checking for updates<span class="update-state">\u2026</span></div>`);
      return;
    }
    if (state === 'ready') {
      draw(host, html`<button class="card-row update-row" type="button" onClick=${on.apply}>A new version is ready<span class="update-pill">Update now</span></button>`);
      return;
    }
    var note = state === 'latest'
      ? html`<span class="update-state is-good">Up to date</span>`
      : state === 'failed'
        ? html`<span class="update-state">No signal</span>`
        : html`<span class="update-state">Check</span>`;
    draw(host, html`<button class="card-row update-row" type="button" onClick=${on.check}>Check for updates${note}</button>`);
  }

  /* ---------------------------------------------------- the diagnostics log */

  /* Folded by default: it is for the grown-up chasing a problem, not for every
   * visit to parent controls. Opened, newest first, because the thing just
   * reported is the thing being looked for. Monospace for the times, which are
   * data and should line up. */
  function logPanel(host: HTMLElement, model: { open: boolean; entries: LogEntry[]; copied: string }, on: any): void {
    var count = model.entries.length;
    var label = count === 1 ? '1 entry' : count + ' entries';
    var head = html`
      <button class="card-row log-toggle" type="button" aria-expanded=${model.open ? 'true' : 'false'}
              onClick=${on.toggle}>
        ${model.open ? 'Hide the log' : 'Show the log'}<span class="log-count">${label}</span>
      </button>`;
    if (!model.open) {
      draw(host, head);
      return;
    }

    var newestFirst = model.entries.slice().reverse();
    var body = count
      ? html`<ol class="log-list">${newestFirst.map(function (e: LogEntry, i: number) {
          return html`<li class=${'log-entry' + (e.k === 'error' ? ' is-error' : '')} key=${e.t + ':' + i}>
            <span class="log-when">${App.log.stamp(e.t).slice(11)}</span>
            <span class="log-kind">${e.k}</span>
            <span class="log-what">${e.m}</span>
          </li>`;
        })}</ol>`
      : html`<p class="log-empty">Nothing logged yet</p>`;

    var note = model.copied === 'copied' ? 'Copied'
      : model.copied === 'failed' ? 'This phone would not copy it' : '';

    draw(host, [
      head,
      body,
      html`<div class="log-actions">
        <span class="log-note" role="status">${note}</span>
        <button class="log-btn" type="button" onClick=${on.copy} disabled=${!count}>Copy</button>
        <button class="log-btn" type="button" onClick=${on.clear} disabled=${!count}>Clear</button>
      </div>`
    ]);
  }

  return {
    logPanel: logPanel,
    updateBanner: updateBanner,
    updateRow: updateRow,
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
