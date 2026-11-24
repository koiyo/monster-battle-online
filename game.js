// モンスターバトル ゲームロジック（サーバー審判方式）
// シャドウバース風：フォロワー（モンスター）を場に出して戦わせ、相手リーダーのHPを0にする。
// カードバトル オンライン版（cardbattle-online）の基盤を流用し、ルールを差し替えたもの。
// - 状態はサーバーが一元管理し、クライアントには viewFor() で
//   「そのプレイヤーが見てよい情報」だけを渡す（相手の手札は枚数のみ、場は公開情報）。
// - カード編集対応：各プレイヤーは自分の編集カードセット＋自作デッキ（30枚）を持ち込める。
//   持ち込みデータは resolveLoadout() で検証・サニタイズし、不正・不成立なら標準に
//   フォールバックする（fallback: true を返し、呼び出し側が本人へ通知する）。
//   フォロワー／スペルの定義参照は「そのカードの持ち主のセット」から引く。
//
// ルール要点:
// - リーダーHP 20。手札4枚スタート、デッキ30枚。
// - エネルギー（PP相当）はターン開始時に最大値+1（上限10）＆全回復。初手の上限は1から。
// - ターン開始時に1ドロー（先攻の1ターン目のみなし）。手札上限9枚。
// - フォロワーは場に最大5体。出してすぐは攻撃できない（召喚酔い）。「疾走」は即攻撃可。
// - フォロワーはターンに1回、相手フォロワーか相手リーダーを攻撃できる。
//   フォロワー同士は攻撃力分を同時に与え合う。体力0以下で破壊され捨て札（墓地）へ。
// - 「守護」がいる間、相手はリーダーや他フォロワーを攻撃できない。
// - ファンファーレ（場に出たとき）／ラストワード（破壊されたとき）効果あり。進化はなし。
// - 山札切れは捨て札を再シャッフル。それも無ければ引くたび1ダメージ。
// - 両者同時にHP0になった場合は手番プレイヤーの勝ち。

// ===== カード定義（標準セット） =====
// follower: { type:'follower', cost, atk, hp, ward?, rush?, fanfare?, lastwords? }
// spell:    { type:'spell', cost, fx, needsTarget?: 'foe' | 'own' }
// fx（共通の効果語彙）:
//   dmgLeader n … 相手リーダーに n ダメージ
//   healLeader n … 自分リーダーを n 回復
//   draw n … n 枚ドロー
//   dmgAllFoe n … 相手フォロワー全体に n ダメージ
//   summon defId … トークンフォロワーを場に出す（空きがある場合のみ）
//   dmgTarget n … 対象の相手フォロワーに n ダメージ（スペル専用・要ターゲット）
//   destroyTarget true … 対象の相手フォロワーを破壊（スペル専用・要ターゲット）
//   buffTarget [a,h] … 対象の自分のフォロワーを +a/+h（スペル専用・要ターゲット）
const CARDS = {
  // --- フォロワー（13種） ---
  slime:    { type: 'follower', name: 'スライム', icon: '🟢', color: '#58a05c', cost: 1, atk: 1, hp: 2, text: 'ぷにぷにした体。' },
  goblin:   { type: 'follower', name: 'ゴブリン', icon: '👺', color: '#7a9e43', cost: 1, atk: 2, hp: 1, text: '攻撃的だが打たれ弱い。' },
  wolf:     { type: 'follower', name: 'オオカミ', icon: '🐺', color: '#6b7f8e', cost: 2, atk: 3, hp: 2, text: '群れを離れた一匹狼。' },
  knight:   { type: 'follower', name: 'ガードナイト', icon: '🛡️', color: '#4a6fa5', cost: 2, atk: 2, hp: 3, ward: true, text: '守護：相手はこのフォロワーを攻撃しなければならない。' },
  fairy:    { type: 'follower', name: 'フェアリー', icon: '🧚', color: '#c77dbb', cost: 2, atk: 1, hp: 1, fanfare: { draw: 1 }, text: 'ファンファーレ：カードを1枚引く。' },
  skeleton: { type: 'follower', name: 'スケルトン', icon: '💀', color: '#8f8f8f', cost: 2, atk: 2, hp: 1, lastwords: { dmgLeader: 1 }, text: 'ラストワード：相手リーダーに1ダメージ。' },
  assassin: { type: 'follower', name: 'アサシン', icon: '🗡️', color: '#5b4a8a', cost: 3, atk: 3, hp: 1, rush: true, text: '疾走：出したターンから攻撃できる。' },
  mage:     { type: 'follower', name: 'メイジ', icon: '🔮', color: '#7a4a9e', cost: 3, atk: 2, hp: 2, fanfare: { dmgLeader: 2 }, text: 'ファンファーレ：相手リーダーに2ダメージ。' },
  treant:   { type: 'follower', name: 'トレント', icon: '🌳', color: '#4e7a3a', cost: 3, atk: 2, hp: 4, lastwords: { summon: 'slime_token' }, text: 'ラストワード：ミニスライム1体を出す。' },
  unicorn:  { type: 'follower', name: 'ユニコーン', icon: '🦄', color: '#d8a7c3', cost: 4, atk: 3, hp: 3, fanfare: { healLeader: 3 }, text: 'ファンファーレ：リーダーを3回復。' },
  golem:    { type: 'follower', name: 'ゴーレム', icon: '🗿', color: '#8a6d3b', cost: 4, atk: 3, hp: 5, ward: true, text: '守護：相手はこのフォロワーを攻撃しなければならない。' },
  phoenix:  { type: 'follower', name: 'フェニックス', icon: '🔥', color: '#d84a1f', cost: 5, atk: 4, hp: 3, lastwords: { dmgLeader: 2 }, text: 'ラストワード：相手リーダーに2ダメージ。' },
  dragon:   { type: 'follower', name: 'ドラゴン', icon: '🐉', color: '#b03a2e', cost: 6, atk: 5, hp: 5, fanfare: { dmgAllFoe: 2 }, text: 'ファンファーレ：相手フォロワー全体に2ダメージ。' },
  // トークン（デッキには入らない。トレントのラストワードで生まれる。編集不可で常に標準定義）
  slime_token: { type: 'follower', name: 'ミニスライム', icon: '🟢', color: '#58a05c', cost: 1, atk: 1, hp: 1, text: 'トレントから生まれた小さなスライム。' },
  // --- スペル（6種） ---
  fireball:  { type: 'spell', name: 'ファイアボール', icon: '🔥', color: '#d84a1f', cost: 2, needsTarget: 'foe', fx: { dmgTarget: 3 }, text: '相手フォロワー1体に3ダメージ。' },
  smite:     { type: 'spell', name: 'スマイト', icon: '⚡', color: '#c98f06', cost: 3, fx: { dmgLeader: 4 }, text: '相手リーダーに4ダメージ。' },
  heal:      { type: 'spell', name: 'ヒール', icon: '✨', color: '#b8860b', cost: 2, fx: { healLeader: 4 }, text: 'リーダーを4回復。' },
  powerup:   { type: 'spell', name: 'パワーアップ', icon: '💪', color: '#2478a6', cost: 1, needsTarget: 'own', fx: { buffTarget: [2, 2] }, text: '自分のフォロワー1体を+2/+2する。' },
  execution: { type: 'spell', name: '必殺の一撃', icon: '☠️', color: '#444444', cost: 4, needsTarget: 'foe', fx: { destroyTarget: true }, text: '相手フォロワー1体を破壊する。' },
  meteor:    { type: 'spell', name: 'メテオ', icon: '☄️', color: '#a0522d', cost: 5, fx: { dmgAllFoe: 3 }, text: '相手フォロワー全体に3ダメージ。' },
};

const TOKEN_ID = 'slime_token';

// デッキ構成（30枚）: フォロワー23枚＋スペル7枚
const DECK_LIST = [
  'slime', 'slime', 'slime', 'goblin', 'goblin',
  'wolf', 'wolf', 'wolf', 'knight', 'knight',
  'fairy', 'fairy', 'skeleton', 'skeleton', 'assassin', 'assassin',
  'mage', 'treant', 'unicorn', 'golem', 'golem', 'phoenix', 'dragon',
  'fireball', 'fireball', 'meteor', 'smite', 'heal', 'powerup', 'execution',
];

const DECK_SIZE = 30;   // デッキは30枚ちょうど
const MAX_COPIES = 3;   // 同じカードは最大3枚まで

// ===== カードセット＋デッキの検証・サニタイズ =====
// 持ち込まれた編集データはそのまま信用せず、以下の方針で検証する
// （cardbattle-online の sanitizeCardSet と同じ考え方）。
// - カードIDは [a-zA-Z0-9_-]{1,64} のみ許可。カード種数は最大64種。
// - 名前は24文字まで（空は不可）、アイコンは1文字、色は #RRGGBB 形式のみ、説明は80文字まで。
// - コスト0〜10、フォロワーの攻撃0〜15／体力1〜20、
//   効果数値は dmgLeader/healLeader/dmgAllFoe 0〜10、draw 0〜3、dmgTarget 0〜15、
//   buffTarget は各0〜10 に丸める。destroyTarget は true のみ。summon はトークンのみ許可。
// - スペルの対象要否（needsTarget）は効果からサーバー側で決め直す（送信値は信用しない）。
// - トークン（slime_token）は編集不可で、常に標準定義をセットへ強制的に含める。
// - デッキは30枚ちょうど・同名最大3枚・セットに存在するカードのみ（トークンは不可）。
const MAX_CARD_KINDS = 64;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function clampInt(v, min, max, fb) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fb || 0;
  return Math.max(min, Math.min(max, n));
}

// 効果オブジェクトの検証。kind: 'follower'（ファンファーレ／ラストワード用）| 'spell'
// 許可されたキーだけを残し、数値は上限に丸める。使えるキーが無ければ null。
function sanitizeFx(raw, kind) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fx = {};
  const dmgLeader = clampInt(raw.dmgLeader, 0, 10, 0); if (dmgLeader) fx.dmgLeader = dmgLeader;
  const healLeader = clampInt(raw.healLeader, 0, 10, 0); if (healLeader) fx.healLeader = healLeader;
  const draw = clampInt(raw.draw, 0, 3, 0); if (draw) fx.draw = draw;
  const dmgAllFoe = clampInt(raw.dmgAllFoe, 0, 10, 0); if (dmgAllFoe) fx.dmgAllFoe = dmgAllFoe;
  if (raw.summon === TOKEN_ID) fx.summon = TOKEN_ID;
  if (kind === 'spell') {
    const dmgTarget = clampInt(raw.dmgTarget, 0, 15, 0); if (dmgTarget) fx.dmgTarget = dmgTarget;
    if (raw.destroyTarget === true) fx.destroyTarget = true;
    if (Array.isArray(raw.buffTarget)) {
      fx.buffTarget = [clampInt(raw.buffTarget[0], 0, 10, 0), clampInt(raw.buffTarget[1], 0, 10, 0)];
    }
  }
  return Object.keys(fx).length ? fx : null;
}

// 絵文字を書記素（見た目1文字）単位で先頭1つだけ取り出す。
// [...str][0] だと 🛡️ の異体字セレクタ（U+FE0F）が落ちてしまうため Intl.Segmenter を使う。
const graphemeSeg = (typeof Intl !== 'undefined' && Intl.Segmenter)
  ? new Intl.Segmenter('ja', { granularity: 'grapheme' }) : null;
function firstGrapheme(s) {
  if (!s) return '';
  if (graphemeSeg) {
    for (const part of graphemeSeg.segment(s)) return part.segment;
    return '';
  }
  return [...s][0] || '';
}

function sanitizeCard(raw, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const std = CARDS[id];
  const type = (raw.type === 'follower' || raw.type === 'spell') ? raw.type
    : (std ? std.type : null);
  if (!type) return null;
  const name = typeof raw.name === 'string' ? raw.name.slice(0, 24).trim() : '';
  if (!name) return null;
  let icon = '';
  if (typeof raw.icon === 'string' && raw.icon.trim()) icon = firstGrapheme(raw.icon.trim());
  if (!icon) icon = std ? std.icon : firstGrapheme(name);
  const color = (typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.color))
    ? raw.color : (std ? std.color : '#777777');
  const text = typeof raw.text === 'string' ? raw.text.slice(0, 80) : '';
  const cost = clampInt(raw.cost, 0, 10, std ? std.cost : 2);
  if (type === 'follower') {
    const def = {
      type, name, icon, color, cost,
      atk: clampInt(raw.atk, 0, 15, std && std.type === 'follower' ? std.atk : 1),
      hp: clampInt(raw.hp, 1, 20, std && std.type === 'follower' ? std.hp : 1),
      text,
    };
    if (raw.ward === true) def.ward = true;
    if (raw.rush === true) def.rush = true;
    const fanfare = sanitizeFx(raw.fanfare, 'follower'); if (fanfare) def.fanfare = fanfare;
    const lastwords = sanitizeFx(raw.lastwords, 'follower'); if (lastwords) def.lastwords = lastwords;
    return def;
  }
  // スペル
  const fx = sanitizeFx(raw.fx, 'spell') || {};
  const def = { type, name, icon, color, cost, fx, text };
  // 対象要否は効果から決め直す
  if (fx.dmgTarget || fx.destroyTarget) def.needsTarget = 'foe';
  else if (fx.buffTarget) def.needsTarget = 'own';
  return def;
}

// カードセット全体（id → 定義のマップ）を検証する。使える形にならなければ null。
// トークンは常に標準定義で含める。
function sanitizeCardSet(rawCards) {
  if (!rawCards || typeof rawCards !== 'object' || Array.isArray(rawCards)) return null;
  const clean = {};
  let idx = 0;
  for (const rawId of Object.keys(rawCards)) {
    if (Object.keys(clean).length >= MAX_CARD_KINDS) break;
    if (rawId === TOKEN_ID) continue; // トークンは編集不可（後で標準を入れる）
    const card = sanitizeCard(rawCards[rawId], rawId);
    if (!card) continue;
    let id = ID_PATTERN.test(rawId) ? rawId : `custom_${idx++}`;
    if (clean[id]) id = `${id}_${idx++}`;
    clean[id] = card;
  }
  if (Object.keys(clean).length === 0) return null;
  clean[TOKEN_ID] = { ...CARDS[TOKEN_ID] };
  return clean;
}

// デッキ（defId の配列）を検証する。30枚ちょうど・同名最大3枚・
// セットに存在するカードのみ（トークン不可）。成立しなければ null。
function validateDeck(cards, rawDeck) {
  if (!cards || !Array.isArray(rawDeck)) return null;
  if (rawDeck.length !== DECK_SIZE) return null;
  const counts = {};
  for (const id of rawDeck) {
    if (typeof id !== 'string' || id === TOKEN_ID || !cards[id]) return null;
    counts[id] = (counts[id] || 0) + 1;
    if (counts[id] > MAX_COPIES) return null;
  }
  return rawDeck.slice();
}

function sameFx(a, b) {
  const fa = a || {}, fb = b || {};
  const ka = Object.keys(fa), kb = Object.keys(fb);
  if (ka.length !== kb.length) return false;
  return ka.every(k => JSON.stringify(fa[k]) === JSON.stringify(fb[k]));
}

function sameCard(a, b) {
  if (!a || !b) return false;
  if (a.type !== b.type || a.name !== b.name || a.icon !== b.icon || a.color !== b.color ||
      a.cost !== b.cost || a.text !== b.text) return false;
  if (a.type === 'follower') {
    if (a.atk !== b.atk || a.hp !== b.hp || !!a.ward !== !!b.ward || !!a.rush !== !!b.rush) return false;
    return sameFx(a.fanfare, b.fanfare) && sameFx(a.lastwords, b.lastwords);
  }
  if ((a.needsTarget || null) !== (b.needsTarget || null)) return false;
  return sameFx(a.fx, b.fx);
}

// サニタイズ済みの持ち込みが標準セット＋標準デッキと同一内容かどうか
function isStandardLoadout(cards, deckList) {
  const ids = Object.keys(CARDS);
  if (Object.keys(cards).length !== ids.length) return false;
  for (const id of ids) {
    if (!sameCard(cards[id], CARDS[id])) return false;
  }
  if (deckList.length !== DECK_LIST.length) return false;
  const count = (list, id) => list.filter(x => x === id).length;
  return ids.every(id => count(deckList, id) === count(DECK_LIST, id));
}

// 持ち込みデータ { cards, deck } を解決する。
// - raw が未指定（null/undefined）→ 標準（フォールバックではない）
// - raw が不正・不成立 → 標準にフォールバック（fallback: true。呼び出し側で本人へ通知）
// - raw が有効 → サニタイズ済みセット＋デッキ。標準と同一内容なら custom: false
function resolveLoadout(raw) {
  const standard = () => ({ cards: CARDS, deckList: DECK_LIST.slice(), custom: false, fallback: false });
  if (raw == null) return standard();
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ...standard(), fallback: true };
  const cards = sanitizeCardSet(raw.cards);
  const deckList = cards ? validateDeck(cards, raw.deck) : null;
  if (!cards || !deckList) return { ...standard(), fallback: true };
  return { cards, deckList, custom: !isStandardLoadout(cards, deckList), fallback: false };
}

// すでに解決済みの loadout かどうか（newGame/startGame へ直接渡された場合の判定）
function asLoadout(x) {
  if (x && typeof x === 'object' && x.cards && Array.isArray(x.deckList)) {
    return { cards: x.cards, deckList: x.deckList, custom: !!x.custom, fallback: !!x.fallback };
  }
  return resolveLoadout(x);
}

const START_HP = 20;
const START_HAND = 4;
const HAND_LIMIT = 9;
const FIELD_LIMIT = 5;
const MAX_ENERGY_CAP = 10;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let cardUid = 1;
function makeCard(defId) { return { uid: cardUid++, defId }; }

function makePlayer(name, loadout) {
  const lo = asLoadout(loadout);
  return {
    name,
    cards: lo.cards, // このプレイヤーのカードセット（定義参照はここから引く）
    customDeck: lo.custom,
    hp: START_HP, maxhp: START_HP,
    energy: 0, maxEnergy: 0,
    deck: shuffle(lo.deckList.map(makeCard)), hand: [], discard: [],
    field: [], // フォロワー実体 { uid, defId, atk, hp, maxHp, sick, attacked }
  };
}

function newGame(name1, loadout1) {
  const lo1 = asLoadout(loadout1);
  const g = {
    phase: 'waiting', // waiting -> playing -> over
    loadouts: [lo1, null], // 再戦時に同じ持ち込みで作り直すために保持
    players: [makePlayer(name1 || 'プレイヤー1', lo1)],
    turn: 0,
    turnCount: 0,
    winner: null,
    lastPlay: null, // { who, name, text }
    log: [],
  };
  drawCards(g, g.players[0], START_HAND, true);
  return g;
}

function addLog(g, text, mark) {
  g.log.push({ text, mark: !!mark });
  if (g.log.length > 60) g.log.shift();
}

function startGame(g, name2, loadout2) {
  const lo2 = asLoadout(loadout2);
  g.loadouts[1] = lo2;
  const p2 = makePlayer(name2 || 'プレイヤー2', lo2);
  g.players.push(p2);
  drawCards(g, p2, START_HAND, true);
  g.phase = 'playing';
  addLog(g, `バトル開始！ ${g.players[0].name} vs ${p2.name}`, true);
  startTurn(g, true);
}

// 山札切れ→捨て札再シャッフル、それも無ければ1ダメージ。手札上限を超える分は捨て札へ。
function drawCards(g, p, n, silent) {
  for (let i = 0; i < n; i++) {
    if (p.deck.length === 0) {
      if (p.discard.length > 0) {
        p.deck = shuffle(p.discard); p.discard = [];
        if (!silent) addLog(g, `${p.name} は捨て札をシャッフルして山札に戻した`);
      } else {
        p.hp -= 1;
        if (!silent) addLog(g, `${p.name} は山札切れで1ダメージ`);
        continue;
      }
    }
    const card = p.deck.pop();
    if (p.hand.length >= HAND_LIMIT) {
      p.discard.push(card);
      if (!silent) addLog(g, `${p.name} の手札が上限で ${p.cards[card.defId] ? p.cards[card.defId].name : card.defId} は捨て札に`);
    } else {
      p.hand.push(card);
    }
  }
}

// ターン開始: エネルギー最大値+1＆全回復、自軍フォロワーの召喚酔い・攻撃済みを解除、
// 1ドロー（試合の先手の初ターンのみドローなし）。
function startTurn(g, isFirst) {
  if (g.phase !== 'playing') return;
  const me = g.players[g.turn];
  g.turnCount++;
  me.maxEnergy = Math.min(MAX_ENERGY_CAP, me.maxEnergy + 1);
  me.energy = me.maxEnergy;
  for (const f of me.field) { f.sick = false; f.attacked = false; }
  addLog(g, `${me.name} のターン（ターン${Math.ceil(g.turnCount / 2)}）`, true);
  if (!isFirst) {
    drawCards(g, me, 1, false);
    if (checkEnd(g)) return;
  }
  g.lastPlay = null;
}

// 非ターゲット効果（ファンファーレ／ラストワード／対象不要スペル）の解決。
// ダメージでフォロワーが倒れても、ここでは倒壊処理をせず呼び出し側の resolveDeaths に任せる。
function resolveFx(g, pi, fx) {
  const me = g.players[pi];
  const foe = g.players[1 - pi];
  const parts = [];
  if (fx.dmgLeader) { foe.hp -= fx.dmgLeader; parts.push(`${foe.name} に ${fx.dmgLeader} ダメージ`); }
  if (fx.healLeader) {
    const before = me.hp;
    me.hp = Math.min(me.maxhp, me.hp + fx.healLeader);
    parts.push(`HP ${me.hp - before} 回復`);
  }
  if (fx.dmgAllFoe) {
    for (const f of foe.field) f.hp -= fx.dmgAllFoe;
    if (foe.field.length) parts.push(`相手フォロワー全体に ${fx.dmgAllFoe} ダメージ`);
  }
  if (fx.summon) {
    if (me.field.length < FIELD_LIMIT) {
      const def = me.cards[fx.summon];
      if (def) {
        me.field.push({ uid: cardUid++, defId: fx.summon, atk: def.atk, hp: def.hp, maxHp: def.hp, sick: true, attacked: false });
        parts.push(`${def.name} を出した`);
      }
    }
  }
  if (fx.draw) { drawCards(g, me, fx.draw, false); parts.push(`${fx.draw}枚ドロー`); }
  return parts;
}

// 体力0以下のフォロワーを場から墓地へ送り、ラストワードを解決する。
// ラストワードで新たな破壊が起きてもよいよう、無くなるまで繰り返す。
function resolveDeaths(g) {
  let guard = 0;
  while (guard++ < 20) {
    const dead = [];
    g.players.forEach((p, pi) => {
      for (let i = p.field.length - 1; i >= 0; i--) {
        if (p.field[i].hp <= 0) { dead.unshift({ owner: pi, f: p.field[i] }); p.field.splice(i, 1); }
      }
    });
    if (!dead.length) break;
    for (const d of dead) {
      const def = g.players[d.owner].cards[d.f.defId];
      g.players[d.owner].discard.push({ uid: d.f.uid, defId: d.f.defId });
      addLog(g, `${def.name} は破壊された`);
      if (def.lastwords) {
        const parts = resolveFx(g, d.owner, def.lastwords);
        if (parts.length) addLog(g, `${def.name} のラストワード： ${parts.join('、')}`);
      }
    }
    if (checkEnd(g)) return;
  }
}

// カードを出す。
// target: ターゲットを取るスペルのみ { side: 'foe' | 'own', uid }（対象フォロワーの uid）
function playCard(g, pi, handIndex, target) {
  if (g.phase !== 'playing') return { error: 'ゲームが始まっていません' };
  if (pi !== g.turn) return { error: '相手のターンです' };
  const me = g.players[pi];
  const foe = g.players[1 - pi];
  const card = me.hand[handIndex];
  if (!card) return { error: 'そのカードはありません' };
  const def = me.cards[card.defId];
  if (!def) return { error: 'そのカードはありません' };
  if (def.cost > me.energy) return { error: 'エネルギーが足りません' };

  if (def.type === 'follower') {
    if (me.field.length >= FIELD_LIMIT) return { error: '場が満員です（最大5体）' };
    me.energy -= def.cost;
    me.hand.splice(handIndex, 1);
    const f = {
      uid: card.uid, defId: card.defId,
      atk: def.atk, hp: def.hp, maxHp: def.hp,
      sick: !def.rush, attacked: false,
    };
    me.field.push(f);
    g.lastPlay = { who: me.name, name: def.name, text: def.text };
    addLog(g, `${me.name} は「${def.name}」を出した（${def.atk}/${def.hp}）`);
    if (def.fanfare) {
      const parts = resolveFx(g, pi, def.fanfare);
      if (parts.length) addLog(g, `${def.name} のファンファーレ： ${parts.join('、')}`);
    }
  } else {
    // スペル
    let targetF = null;
    if (def.needsTarget) {
      if (!target || (target.side !== 'foe' && target.side !== 'own')) return { error: '対象を選んでください' };
      if (def.needsTarget === 'foe' && target.side !== 'foe') return { error: '相手のフォロワーを選んでください' };
      if (def.needsTarget === 'own' && target.side !== 'own') return { error: '自分のフォロワーを選んでください' };
      const owner = target.side === 'foe' ? foe : me;
      targetF = owner.field.find(f => f.uid === target.uid);
      if (!targetF) return { error: '対象のフォロワーがいません' };
    }
    me.energy -= def.cost;
    me.hand.splice(handIndex, 1);
    me.discard.push(card);
    g.lastPlay = { who: me.name, name: def.name, text: def.text };
    const parts = [];
    const targetDef = targetF ? (target.side === 'foe' ? foe : me).cards[targetF.defId] : null;
    if (def.fx.dmgTarget) { targetF.hp -= def.fx.dmgTarget; parts.push(`${targetDef.name} に ${def.fx.dmgTarget} ダメージ`); }
    if (def.fx.destroyTarget) { targetF.hp = 0; parts.push(`${targetDef.name} を破壊`); }
    if (def.fx.buffTarget) {
      targetF.atk += def.fx.buffTarget[0];
      targetF.hp += def.fx.buffTarget[1];
      targetF.maxHp += def.fx.buffTarget[1];
      parts.push(`${targetDef.name} を +${def.fx.buffTarget[0]}/+${def.fx.buffTarget[1]}`);
    }
    parts.push(...resolveFx(g, pi, def.fx));
    addLog(g, `${me.name} の「${def.name}」： ${parts.join('、') || def.text}`);
  }
  resolveDeaths(g);
  checkEnd(g);
  return { ok: true };
}

// フォロワーの攻撃。
// target: { type: 'leader' } または { type: 'follower', uid }
function attack(g, pi, attackerUid, target) {
  if (g.phase !== 'playing') return { error: 'ゲームが始まっていません' };
  if (pi !== g.turn) return { error: '相手のターンです' };
  const me = g.players[pi];
  const foe = g.players[1 - pi];
  const atk = me.field.find(f => f.uid === attackerUid);
  if (!atk) return { error: 'そのフォロワーはいません' };
  if (atk.sick) return { error: '出したターンには攻撃できません（召喚酔い）' };
  if (atk.attacked) return { error: 'このフォロワーはすでに攻撃しました' };
  if (atk.atk <= 0) return { error: '攻撃力が0のフォロワーは攻撃できません' };
  if (!target || (target.type !== 'leader' && target.type !== 'follower')) return { error: '攻撃対象を選んでください' };

  const wards = foe.field.filter(f => foe.cards[f.defId].ward);
  if (target.type === 'leader') {
    if (wards.length) return { error: '守護がいるためリーダーを攻撃できません' };
    atk.attacked = true;
    foe.hp -= atk.atk;
    addLog(g, `${me.cards[atk.defId].name} の攻撃： ${foe.name} に ${atk.atk} ダメージ`);
  } else {
    const tf = foe.field.find(f => f.uid === target.uid);
    if (!tf) return { error: '対象のフォロワーがいません' };
    if (wards.length && !foe.cards[tf.defId].ward) return { error: '守護のフォロワーを攻撃しなければなりません' };
    atk.attacked = true;
    tf.hp -= atk.atk;
    atk.hp -= tf.atk;
    addLog(g, `${me.cards[atk.defId].name} の攻撃： ${foe.cards[tf.defId].name} と戦闘（${atk.atk} ⇔ ${tf.atk}）`);
  }
  resolveDeaths(g);
  checkEnd(g);
  return { ok: true };
}

function endTurn(g, pi) {
  if (g.phase !== 'playing') return { error: 'ゲームが始まっていません' };
  if (pi !== g.turn) return { error: '相手のターンです' };
  addLog(g, `${g.players[pi].name} はターン終了`);
  g.turn = 1 - g.turn;
  startTurn(g, false);
  return { ok: true };
}

// 降参：自分の意思でいつでも降参でき、降参した側の負け。
function surrender(g, pi) {
  if (g.phase !== 'playing') return { error: 'ゲームが始まっていません' };
  addLog(g, `${g.players[pi].name} が降参した`);
  g.players[pi].hp = 0;
  checkEnd(g);
  return { ok: true };
}

// 勝敗判定：両者同時HP0なら手番プレイヤーの勝ち。
function checkEnd(g) {
  if (g.phase !== 'playing') return false;
  const [p0, p1] = g.players;
  if (p0.hp > 0 && p1.hp > 0) return false;
  g.phase = 'over';
  let loserIdx;
  if (p0.hp <= 0 && p1.hp <= 0) loserIdx = 1 - g.turn;
  else loserIdx = p0.hp <= 0 ? 0 : 1;
  g.winner = 1 - loserIdx;
  p0.hp = Math.max(0, p0.hp); p1.hp = Math.max(0, p1.hp);
  addLog(g, `${g.players[g.winner].name} の勝利！`, true);
  return true;
}

function restart(g) {
  const names = g.players.map(p => p.name);
  const loadouts = g.loadouts;
  const fresh = newGame(names[0], loadouts[0]);
  Object.assign(g, fresh);
  startGame(g, names[1], loadouts[1]);
}

// フォロワーの公開ビュー（場は両者とも公開情報）。cards は持ち主のセット。
function followerView(f, cards) {
  const def = cards[f.defId];
  return {
    uid: f.uid, defId: f.defId,
    name: def.name, icon: def.icon, color: def.color, cost: def.cost,
    atk: f.atk, hp: f.hp, maxHp: f.maxHp,
    ward: !!def.ward, rush: !!def.rush,
    sick: f.sick, canAttack: !f.sick && !f.attacked,
    text: def.text,
  };
}

// クライアントへ送る「そのプレイヤーから見た」状態。
// 自分の手札だけ中身を含み、相手は手札枚数・山札枚数のみ（場は公開）。
function viewFor(g, pi) {
  const me = g.players[pi];
  const foe = g.players[1 - pi];
  const pub = (p) => p ? ({
    name: p.name,
    hp: Math.max(0, p.hp), maxhp: p.maxhp,
    energy: p.energy, maxEnergy: p.maxEnergy,
    handCount: p.hand.length, deckCount: p.deck.length,
    field: p.field.map(f => followerView(f, p.cards)),
  }) : null;
  return {
    phase: g.phase,
    turn: g.turn,
    turnNumber: Math.ceil(Math.max(1, g.turnCount) / 2),
    youAre: pi,
    isMyTurn: g.phase === 'playing' && g.turn === pi,
    winner: g.winner,
    winnerName: g.winner != null ? g.players[g.winner].name : null,
    turnCount: g.turnCount,
    me: me ? {
      ...pub(me),
      customDeck: !!me.customDeck,
      hand: me.hand.map(c => {
        const def = me.cards[c.defId];
        return {
          uid: c.uid, defId: c.defId, type: def.type,
          name: def.name, icon: def.icon, color: def.color, cost: def.cost,
          atk: def.atk, hp: def.hp, ward: !!def.ward, rush: !!def.rush,
          needsTarget: def.needsTarget || null,
          text: def.text,
        };
      }),
    } : null,
    foe: pub(foe),
    lastPlay: g.lastPlay,
    log: g.log.slice(-40),
  };
}

module.exports = {
  CARDS, DECK_LIST, DECK_SIZE, MAX_COPIES, TOKEN_ID,
  newGame, startGame, playCard, attack, endTurn, surrender, restart, viewFor,
  resolveLoadout, sanitizeCardSet, sanitizeCard, validateDeck,
  // テスト用に内部関数も公開
  _internal: { makePlayer, makeCard, drawCards, startTurn, checkEnd, resolveDeaths, resolveFx, isStandardLoadout },
};
