// The rooms pass of the real-extension check: rooms joining and leaving running casts, over and
// over, with the first event of every new subscription lost as the subscribe race loses it on real
// speakers. After each step every room of a cast must show its level within about a second, and
// every room's badge in the picker must say what the household is doing: "In use" only for a room
// playing something that is not a cast. Run from check.mjs.
import * as lib from './lib.mjs';

/** How long a room in a cast may show "…" once it is listed. */
const LEVEL_MS = 1200;

/** How many times the add, remove and Undo round runs. */
const ROUNDS = 4;

/**
 * The room rows of every open CastTile: name and what its slider says.
 * @param {import('./lib.mjs').Target} p - The popup
 * @returns {Promise<Array<[string, string]>>} `[room, value]` per row ("…" when not known)
 */
async function castRows(p) {
  await p.eval(`document.querySelectorAll('details').forEach((d) => { d.open = true; })`);
  return p.eval(`return [...document.querySelectorAll('section input[type=range]')]
    .map((r) => [r.getAttribute('aria-label').replace(/ volume$/, ''), r.getAttribute('aria-valuetext')])
    .filter(([name]) => !name.includes(' + '))`);
}

/**
 * The rooms this browser casts to, per cast, from the background.
 * @param {import('./lib.mjs').Target} p - The popup
 * @returns {Promise<string[][]>} Room names per cast
 */
function casts(p) {
  return p.eval(`return chrome.runtime.sendMessage({ type: 'GET_ACTIVE_CASTS' })
    .then((r) => r.casts.map((c) => c.speakerNames))`);
}

/**
 * The picker's rows: name, whether it is ticked, and its badge's text.
 * @param {import('./lib.mjs').Target} p - The popup
 * @returns {Promise<Array<{name: string, checked: boolean, badge: string}>>} One per room
 */
function pickerRows(p) {
  return p.eval(`return [...document.querySelectorAll('label')]
    .filter((l) => l.querySelector('input[type=checkbox]'))
    .map((l) => ({
      name: l.innerText.split('\\n')[0].trim(),
      checked: l.querySelector('input[type=checkbox]').checked,
      badge: [...l.querySelectorAll('[data-tone], [class*=badge]')].map((b) => b.innerText).join(' '),
      text: l.innerText,
    }))`);
}

/**
 * The rooms the household says play something that is not a cast: their group's coordinator is
 * playing a URI that is not one of the companion's streams.
 * @returns {Promise<Set<string>>} Room names
 */
async function inUseNow() {
  const rows = (await lib.control('/state'))
    .split('\n')
    .filter((l) => l.includes('\tcoord='))
    .map((l) => {
      const [name] = l.split('\t');
      const field = (key) =>
        l
          .split('\t')
          .find((f) => f.startsWith(key + '='))
          ?.slice(key.length + 1);
      return {
        name,
        playing: / Playing\t|\tPlaying\t/.test(l),
        coord: field('coord'),
        uri: field('uri') ?? '',
      };
    });
  const byName = new Map(rows.map((r) => [r.name, r]));
  const busy = new Set();
  for (const r of rows) {
    const lead = byName.get(r.coord) ?? r;
    if (lead.playing && lead.uri && !lead.uri.includes('/stream/')) busy.add(r.name);
  }
  return busy;
}

/**
 * Ticks exactly `names` in the picker.
 * @param {import('./lib.mjs').Target} p - The popup
 * @param {string[]} names - The rooms to tick
 */
async function choose(p, names) {
  for (const row of await pickerRows(p)) {
    if (row.checked !== names.includes(row.name)) await p.clickRoom(row.name);
  }
}

/**
 * Runs the rooms pass.
 * @param {object} env - What lib.launch() returned
 * @param {object} tools - The check's helpers
 * @param {(name: string, ok: boolean, detail?: unknown) => void} tools.check - Records a check
 * @param {(target: object, step: string) => Promise<string>} tools.shot - Saves a screenshot
 * @param {boolean} tools.dark - The colour scheme
 * @returns {Promise<string[]>} Console problems the popups logged
 */
export async function roomsPass(env, { check, shot, dark }) {
  const problems = [];
  const failures = { levels: [], badges: [] };

  /**
   * Waits for the casts to hold `want` (room names per cast, any order), then checks that every
   * listed room shows its level within LEVEL_MS.
   * @param {import('./lib.mjs').Target} p - The popup
   * @param {string} step - What was done
   * @param {string[][]} want - The rooms per cast
   */
  async function levels(p, step, want) {
    const key = (lists) =>
      lists
        .map((l) => [...l].sort().join('+'))
        .sort()
        .join(' | ');
    const t0 = Date.now();
    let held;
    while (Date.now() - t0 < 8000) {
      held = await casts(p);
      if (key(held) === key(want)) break;
      await lib.sleep(150);
    }
    if (key(held) !== key(want)) {
      failures.levels.push({ step, want: key(want), held: key(held) });
      return;
    }
    const listed = Date.now();
    let rows;
    while (Date.now() - listed < LEVEL_MS + 3000) {
      rows = await castRows(p);
      const unknown = rows.filter(([, v]) => v === '…');
      if (rows.length > 0 && unknown.length === 0) return;
      const shown = rows.length > 0 && Date.now() - listed > LEVEL_MS;
      if (shown) break;
      await lib.sleep(100);
    }
    failures.levels.push({ step, rows });
  }

  /**
   * Checks that the picker's "In use" badges match the household.
   * @param {import('./lib.mjs').Target} p - The popup, its picker showing
   * @param {string} step - What was done
   */
  async function badges(p, step) {
    // Events settle within a pump tick and the extension's debounce.
    await lib.sleep(1500);
    const busy = await inUseNow();
    const rows = await pickerRows(p);
    const wrong = rows
      .filter((r) => /in use/i.test(r.text) !== busy.has(r.name))
      .map((r) => `${r.name}: ${/in use/i.test(r.text) ? 'says in use' : 'misses in use'}`);
    if (rows.length === 0) failures.badges.push({ step, wrong: ['no picker rows'] });
    else if (wrong.length) failures.badges.push({ step, wrong });
  }

  const groupingNow = async () =>
    (await lib.control('/state')).split('\n').find((l) => l.startsWith('grouping='));
  const before = await groupingNow();
  await lib.control('/knobs?initial_rc=0&initial_grc=0&initial_avt=0');
  const tab = await env.audioTab(await env.ctx.newPage());
  let p = await env.popup({ dark });

  // ── One cast: rooms leave, come back with Undo, and are added again ────
  const first = ['Kitchen', 'Living Room', 'Bedroom'];
  await choose(p, first);
  await p.click('button', 'Cast to');
  await levels(p, 'cast to three rooms', [first]);
  let inCast = [...first];
  for (let round = 0; round < ROUNDS; round++) {
    const room = inCast[round % inCast.length];
    await p.click(`button[aria-label="Remove ${room}"]`);
    await lib.sleep([0, 300, 700, 1200][round % 4]);
    await p.click('button[aria-label^="Undo"]').catch(() => {});
    await levels(p, `round ${round}: remove ${room}, Undo`, [inCast]);

    const gone = inCast[(round + 1) % inCast.length];
    await p.click(`button[aria-label="Remove ${gone}"]`);
    inCast = inCast.filter((r) => r !== gone);
    await levels(p, `round ${round}: remove ${gone}`, [inCast]);
    await p.click('button', 'Add a room');
    await lib.sleep(500);
    await badges(p, `round ${round}: after ${gone} left`);
    await p.clickRoom(gone);
    await p.click('button', 'Add 1 room');
    inCast = [...inCast, gone];
    await levels(p, `round ${round}: add ${gone} back`, [inCast]);
  }
  await shot(p, '11-rooms-round');

  // ── A second tab casts to one room of the first cast, alone ───────────
  problems.push(...p.problems);
  p.close();
  const tab2 = await env.audioTab(await env.ctx.newPage());
  p = await env.popup({ dark });
  const taken = inCast[0];
  await choose(p, [taken]);
  await p.click('button', 'Cast to');
  const kept = inCast.filter((r) => r !== taken);
  await levels(p, `second tab takes ${taken} alone`, [kept, [taken]]);
  await shot(p, '12-rooms-second-cast');
  const both = await casts(p);
  const firstNow = both.find((c) => !c.includes(taken));
  check(
    'a cast that loses a room to another plays on in every room it keeps',
    both.length === 2 &&
      firstNow?.length === kept.length &&
      kept.every((r) => firstNow.includes(r)),
    { kept, casts: both },
  );

  // ── Stop both: nothing reads as in use but the music playing ──────────
  for (let i = 0; i < 2; i++) {
    await p.click('button[aria-label^="Stop"]').catch(() => {});
    await lib.sleep(1200);
  }
  await badges(p, 'after Stop');
  const after = await groupingNow();
  check('after Stop every room is back in the Sonos group it was in', after === before, {
    before,
    after,
  });
  await shot(p, '13-rooms-stopped');

  // ── A room in a group of others cast alone: it leaves its group, and it has no level of
  // its own on record (its group's is its coordinator's). Below the start cap, its start
  // sets nothing, so nothing is read on the way ───────────────────────────────────────────
  await lib.control('/volume?room=Study&v=21');
  await lib.control('/regroup?member=Study&coordinator=Bedroom');
  await lib.control('/refresh');
  await lib.sleep(1000);
  problems.push(...p.problems);
  p.close();
  p = await env.popup({ dark });
  await choose(p, ['Study']);
  await p.click('button', 'Cast to');
  await levels(p, 'a grouped room cast alone', [['Study']]);
  await shot(p, '14-rooms-alone');
  await p.click('button[aria-label^="Stop"]').catch(() => {});
  await lib.sleep(1200);
  problems.push(...p.problems);
  p.close();

  // ── The lead of a group playing music is cast alone: Sonos hands the music to the room it
  // leaves, which has only ever followed (nothing recorded for it) and whose first event is
  // lost. It must still say "In use" ─────────────────────────────────────────────────────
  await lib.control('/regroup?member=Living%20Room&coordinator=Kitchen');
  await lib.control('/play_music?room=Kitchen');
  await lib.control('/refresh');
  await lib.control('/forget?room=Living%20Room');
  await lib.sleep(1000);
  p = await env.popup({ dark });
  await choose(p, ['Kitchen']);
  await p.click('button', 'Cast to');
  await levels(p, 'the lead of a music group cast alone', [['Kitchen']]);
  await p.click('button', 'Add a room');
  await lib.sleep(500);
  await badges(p, 'the room left with the music');
  await shot(p, '15-rooms-inherited');
  await p.click('button', 'Cancel').catch(() => {});
  await p.click('button[aria-label^="Stop"]').catch(() => {});
  await lib.sleep(1200);
  await badges(p, 'after Stop, back with the music');
  problems.push(...p.problems);
  p.close();
  await tab2.close();
  await tab.close();
  await lib.control('/knobs?initial_rc=1&initial_grc=1&initial_avt=1');

  check(
    `every room of a cast shows its level within ${LEVEL_MS} ms, through adds, Removes, Undo and a second cast`,
    failures.levels.length === 0,
    failures.levels,
  );
  check(
    'every room says "In use" exactly when it plays something else, after Remove, Undo and Stop',
    failures.badges.length === 0,
    failures.badges,
  );
  return problems;
}
