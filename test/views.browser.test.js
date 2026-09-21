/* Bedtime - the lists, in a real browser, in a couple of seconds.
 *
 *   npm run test:views
 *
 * These render the real view functions and then ask for things the way a
 * person would: the button called "Heart this story", the text on the row.
 * Testing Library's queries are the point - a test that looks for `.row-heart`
 * goes on passing after the button has lost its name and nobody can find it.
 *
 * What this layer cannot reach is why the end-to-end suites still exist: no
 * audio, no IndexedDB, no service worker, no gestures. This is for what is on
 * the screen and what it is called.
 */
import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { within, fireEvent } from '@testing-library/preact';

/* The app's scripts are plain files that hang themselves on a global `App`.
 * They are loaded here as script tags, in the order index.html loads them,
 * rather than imported: they are scripts, not modules, and a bundler that
 * treats them as modules gives them a different `this`.
 */
const SCRIPTS = [
  '/assets/vendor/preact.umd.js',
  '/assets/vendor/htm.umd.js',
  '/assets/js/log.js',
  '/assets/js/ui.js',
  '/assets/js/views.js',
];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = src;
    tag.onload = () => resolve();
    tag.onerror = () => reject(new Error('could not load ' + src));
    document.head.appendChild(tag);
  });
}

const App = () => window.App;

const story = (over) => ({
  id: 's1', title: 'Sleepy Foxes', len: 600, size: 1024, chunkCount: 1, addedAt: 1, hue: 0, ...over,
});

const noop = () => {};
const rowHandlers = (over) => ({
  open: noop, fav: noop, menu: noop, meta: () => '10 min · added by you', ...over,
});

let host;

beforeAll(async () => {
  for (const src of SCRIPTS) await loadScript(src);
  // Cover art comes out of IndexedDB in the real app. There is none here,
  // which is the striped-cover path all of these stories take anyway.
  window.App.media = { artUrl: () => Promise.resolve(null) };
});

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
});

const ui = () => within(host);

describe('a story in the library', () => {
  test('is announced by its title and its length', () => {
    App().views.rows(host, [story()], rowHandlers());
    expect(ui().getByText('Sleepy Foxes')).toBeTruthy();
    expect(ui().getByText('10 min · added by you')).toBeTruthy();
  });

  test('offers a heart and a menu that can be found by name', () => {
    App().views.rows(host, [story()], rowHandlers());
    expect(ui().getByRole('button', { name: 'Heart this story' })).toBeTruthy();
    expect(ui().getByRole('button', { name: 'More for Sleepy Foxes' })).toBeTruthy();
  });

  test('draws the heart and the menu as characters, not as entities', () => {
    App().views.rows(host, [story()], rowHandlers());
    expect(ui().getByRole('button', { name: 'Heart this story' }).textContent).toBe('♥');
    expect(ui().getByRole('button', { name: 'More for Sleepy Foxes' }).textContent).toBe('⋯');
  });

  test('offers to unheart one that is already hearted', () => {
    App().views.rows(host, [story({ fav: true })], rowHandlers());
    expect(ui().getByRole('button', { name: 'Unheart this story' })).toBeTruthy();
  });

  test('has no menu when the phone has cleared its audio', () => {
    App().views.rows(host, [story({ missing: true })], rowHandlers({ meta: () => 'Needs adding again' }));
    expect(ui().queryByRole('button', { name: /More for/ })).toBeNull();
  });

  test('opens when tapped, and hearts when its heart is tapped', () => {
    let opened = null;
    let hearted = null;
    App().views.rows(host, [story()], rowHandlers({
      open: (id) => { opened = id; },
      fav: (id) => { hearted = id; },
    }));
    fireEvent.click(ui().getByText('Sleepy Foxes'));
    expect(opened).toBe('s1');
    fireEvent.click(ui().getByRole('button', { name: 'Heart this story' }));
    expect(hearted).toBe('s1');
  });
});

describe('tonight’s picks', () => {
  test('are numbered in the order they will play', () => {
    App().views.picks(host, [story(), story({ id: 's2', title: 'Moon Boat' })], { open: noop });
    expect(ui().getAllByText(/^[12]$/).map((n) => n.textContent)).toEqual(['1', '2']);
    expect(ui().getByText('Moon Boat')).toBeTruthy();
  });
});

describe('an empty library', () => {
  test('says there is nothing yet, and offers a way to add some', () => {
    App().views.emptyState(host, false, { add: noop });
    expect(ui().getByText('No stories yet')).toBeTruthy();
    expect(ui().getByRole('button', { name: /Add stories/ })).toBeTruthy();
  });

  test('says something different when a grown-up has hidden them', () => {
    App().views.emptyState(host, true, { add: noop });
    expect(ui().getByText('Stories are hidden')).toBeTruthy();
  });
});

describe('the sleep timer', () => {
  const model = (over) => ({
    minutes: [10, 20, 30], maxMinutes: 240, chosenMinutes: 20, custom: 0,
    chosenStories: 0, mostStories: 1, ...over,
  });

  test('offers minutes, a box for any other number, and the end of this story', () => {
    App().views.timerOptions(host, model(), { minutes: noop, stories: noop });
    expect(ui().getByRole('button', { name: '10' })).toBeTruthy();
    expect(ui().getByRole('spinbutton', { name: 'Other number of minutes' })).toBeTruthy();
    expect(ui().getByRole('button', { name: 'This one' })).toBeTruthy();
  });

  test('explains why only one story is on offer', () => {
    App().views.timerOptions(host, model(), { minutes: noop, stories: noop });
    expect(ui().getByText(/Line up more of tonight/)).toBeTruthy();
  });

  test('shows a typed number as the one chosen, and more stories when more are queued', () => {
    App().views.timerOptions(host, model({ chosenMinutes: 0, custom: 45, chosenStories: 2, mostStories: 3 }),
      { minutes: noop, stories: noop });
    expect(ui().getByRole('spinbutton', { name: 'Other number of minutes' }).value).toBe('45');
    expect(ui().getByRole('button', { name: '3' })).toBeTruthy();
  });

  test('says which number was chosen', () => {
    let chosen = null;
    App().views.timerOptions(host, model(), { minutes: (m) => { chosen = m; }, stories: noop });
    fireEvent.click(ui().getByRole('button', { name: '10' }));
    expect(chosen).toBe(10);
  });
});

describe('a story’s menu', () => {
  test('lists what can be done, and does it when chosen', () => {
    let ran = false;
    App().views.menuActions(host, [
      { label: 'Add to tonight’s picks', run: () => { ran = true; } },
      { label: 'Cancel', run: noop },
    ]);
    expect(ui().getByRole('button', { name: 'Cancel' })).toBeTruthy();
    fireEvent.click(ui().getByRole('button', { name: 'Add to tonight’s picks' }));
    expect(ran).toBe(true);
  });
});

describe('parent controls', () => {
  test('give every playback switch its label, and say which way one was turned', () => {
    let toggled = null;
    App().views.toggles(host, [
      { key: 'dim', label: 'Screen dims while playing', on: true },
      { key: 'resume', label: 'Remember where each story stopped', on: false },
    ], { toggle: (key, on) => { toggled = `${key}:${on}`; } });
    expect(ui().getByRole('button', { name: /Screen dims while playing/ })).toBeTruthy();
    fireEvent.click(ui().getByRole('button', { name: /Remember where each story stopped/ }));
    expect(toggled).toBe('resume:true');
  });

  test('show what each stored story costs, and offer to remove it', () => {
    App().views.storedList(host, [story({ size: 5 * 1024 * 1024 })], { remove: noop });
    expect(ui().getByText(/5\.0 MB/)).toBeTruthy();
    expect(ui().getByRole('button', { name: 'Remove' })).toBeTruthy();
  });
});

describe('an import in progress', () => {
  test('shows how far it has got', () => {
    App().views.imports(host, [{
      key: 'i1', name: 'Sleepy Foxes', art: 'none', artLabel: 'ART',
      percent: 40, status: '40%', state: '',
    }], { art: noop });
    expect(ui().getByText('40%')).toBeTruthy();
  });
});

describe('an update', () => {
  test('says nothing at all until one is ready', () => {
    App().views.updateBanner(host, { show: false }, { apply: noop, later: noop });
    expect(host.textContent).toBe('');
  });

  test('announces itself politely, without taking over the screen', () => {
    App().views.updateBanner(host, { show: true }, { apply: noop, later: noop });
    expect(ui().getByRole('status')).toBeTruthy();
    expect(ui().getByText('A new version is ready')).toBeTruthy();
    expect(ui().getByText(/every story keeps its place/)).toBeTruthy();
  });

  test('can be taken now, or put off', () => {
    let applied = false;
    let later = false;
    App().views.updateBanner(host, { show: true }, {
      apply: () => { applied = true; },
      later: () => { later = true; },
    });
    fireEvent.click(ui().getByRole('button', { name: 'Later' }));
    expect(later).toBe(true);
    fireEvent.click(ui().getByRole('button', { name: 'Update' }));
    expect(applied).toBe(true);
  });

  describe('in parent controls', () => {
    const row = (state, on) => App().views.updateRow(host, { state }, {
      check: noop, apply: noop, ...on,
    });

    test('offers to check', () => {
      let checked = false;
      row('idle', { check: () => { checked = true; } });
      fireEvent.click(ui().getByRole('button', { name: /Check for updates/ }));
      expect(checked).toBe(true);
    });

    test('says when it is checking, and offers nothing to tap meanwhile', () => {
      row('checking');
      expect(ui().getByText('Checking for updates')).toBeTruthy();
      expect(ui().queryByRole('button')).toBeNull();
    });

    test('says when there is nothing new', () => {
      row('latest');
      expect(ui().getByText('Up to date')).toBeTruthy();
    });

    test('says when it could not look, and why', () => {
      row('failed');
      expect(ui().getByText('No signal')).toBeTruthy();
    });

    test('offers the update itself when one is ready', () => {
      let applied = false;
      row('ready', { apply: () => { applied = true; } });
      fireEvent.click(ui().getByRole('button', { name: /Update now/ }));
      expect(applied).toBe(true);
    });
  });
});

describe('the diagnostics log', () => {
  const entries = [
    { t: new Date(2026, 8, 21, 20, 3, 14).getTime(), k: 'audio', m: 'play' },
    { t: new Date(2026, 8, 21, 20, 3, 20).getTime(), k: 'error', m: 'something broke' },
  ];
  const panel = (model, on) => App().views.logPanel(host, {
    open: false, entries, copied: 'idle', ...model,
  }, { toggle: noop, copy: noop, clear: noop, ...on });

  test('starts folded, and says how much it holds', () => {
    panel({});
    expect(ui().getByRole('button', { name: /Show the log/ })).toBeTruthy();
    expect(ui().getByText('2 entries')).toBeTruthy();
    expect(ui().queryByText('something broke')).toBeNull();
  });

  test('says when there is nothing in it', () => {
    panel({ open: true, entries: [] });
    expect(ui().getByText('Nothing logged yet')).toBeTruthy();
  });

  test('opened, shows the newest first, with the time of each', () => {
    panel({ open: true });
    const items = ui().getAllByRole('listitem').map((n) => n.textContent);
    expect(items[0]).toContain('something broke');
    expect(items[1]).toContain('play');
    expect(items[0]).toContain('20:03:20');
  });

  test('can be copied and cleared', () => {
    let copied = false;
    let cleared = false;
    panel({ open: true }, { copy: () => { copied = true; }, clear: () => { cleared = true; } });
    fireEvent.click(ui().getByRole('button', { name: 'Copy' }));
    fireEvent.click(ui().getByRole('button', { name: 'Clear' }));
    expect(copied && cleared).toBe(true);
  });

  test('says whether a copy worked', () => {
    panel({ open: true, copied: 'copied' });
    expect(ui().getByText('Copied')).toBeTruthy();
  });
});

