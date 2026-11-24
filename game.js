// モンスターバトル ゲームロジック（サーバー審判方式）
// シャドウバース風：フォロワー（モンスター）を場に出して戦わせ、相手リーダーのHPを0にする。
// カードバトル オンライン版（cardbattle-online）の基盤を流用し、ルールを差し替えたもの。
// - 状態はサーバーが一元管理し、クライアントには viewFor() で
//   「そのプレイヤーが見てよい情報」だけを渡す（相手の手札は枚数のみ、場は公開情報）。
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

// ===== カード定義 =====
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
  // トークン（デッキには入らない。トレントのラストワードで生まれる）
  slime_token: { type: 'follower', name: 'ミニスライム', icon: '🟢', color: '#58a05c', cost: 1, atk: 1, hp: 1, text: 'トレントから生まれた小さなスライム。' },
  // --- スペル（6種） ---
  fireball:  { type: 'spell', name: 'ファイアボール', icon: '🔥', color: '#d84a1f', cost: 2, needsTarget: 'foe', fx: { dmgTarget: 3 }, text: '相手フォロワー1体に3ダメージ。' },
  smite:     { type: 'spell', name: 'スマイト', icon: '⚡', color: '#c98f06', cost: 3, fx: { dmgLeader: 4 }, text: '相手リーダーに4ダメージ。' },
  heal:      { type: 'spell', name: 'ヒール', icon: '✨', color: '#b8860b', cost: 2, fx: { healLeader: 4 }, text: 'リーダーを4回復。' },
  powerup:   { type: 'spell', name: 'パワーアップ', icon: '💪', color: '#2478a6', cost: 1, needsTarget: 'own', fx: { buffTarget: [2, 2] }, text: '自分のフォロワー1体を+2/+2する。' },
  execution: { type: 'spell', name: '必殺の一撃', icon: '☠️', color: '#444444', cost: 4, needsTarget: 'foe', fx: { destroyTarget: true }, text: '相手フォロワー1体を破壊する。' },
  meteor:    { type: 'spell', name: 'メテオ', icon: '☄️', color: '#a0522d', cost: 5, fx: { dmgAllFoe: 3 }, text: '相手フォロワー全体に3ダメージ。' },
};

// デッキ構成（30枚）: フォロワー23枚＋スペル7枚
const DECK_LIST = [
  'slime', 'slime', 'slime', 'goblin', 'goblin',
  'wolf', 'wolf', 'wolf', 'knight', 'knight',
  'fairy', 'fairy', 'skeleton', 'skeleton', 'assassin', 'assassin',
  'mage', 'treant', 'unicorn', 'golem', 'golem', 'phoenix', 'dragon',
  'fireball', 'fireball', 'meteor', 'smite', 'heal', 'powerup', 'execution',
];

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

function makePlayer(name) {
  return {
    name,
    hp: START_HP, maxhp: START_HP,
    energy: 0, maxEnergy: 0,
    deck: shuffle(DECK_LIST.map(makeCard)), hand: [], discard: [],
    field: [], // フォロワー実体 { uid, defId, atk, hp, maxHp, sick, attacked }
  };
}

function newGame(name1) {
  const g = {
    phase: 'waiting', // waiting -> playing -> over
    players: [makePlayer(name1 || 'プレイヤー1')],
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

function startGame(g, name2) {
  const p2 = makePlayer(name2 || 'プレイヤー2');
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
      if (!silent) addLog(g, `${p.name} の手札が上限で ${CARDS[card.defId] ? CARDS[card.defId].name : card.defId} は捨て札に`);
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
      const def = CARDS[fx.summon];
      me.field.push({ uid: cardUid++, defId: fx.summon, atk: def.atk, hp: def.hp, maxHp: def.hp, sick: true, attacked: false });
      parts.push(`${def.name} を出した`);
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
      const def = CARDS[d.f.defId];
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
  const def = CARDS[card.defId];
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
    if (def.fx.dmgTarget) { targetF.hp -= def.fx.dmgTarget; parts.push(`${CARDS[targetF.defId].name} に ${def.fx.dmgTarget} ダメージ`); }
    if (def.fx.destroyTarget) { targetF.hp = 0; parts.push(`${CARDS[targetF.defId].name} を破壊`); }
    if (def.fx.buffTarget) {
      targetF.atk += def.fx.buffTarget[0];
      targetF.hp += def.fx.buffTarget[1];
      targetF.maxHp += def.fx.buffTarget[1];
      parts.push(`${CARDS[targetF.defId].name} を +${def.fx.buffTarget[0]}/+${def.fx.buffTarget[1]}`);
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

  const wards = foe.field.filter(f => CARDS[f.defId].ward);
  if (target.type === 'leader') {
    if (wards.length) return { error: '守護がいるためリーダーを攻撃できません' };
    atk.attacked = true;
    foe.hp -= atk.atk;
    addLog(g, `${CARDS[atk.defId].name} の攻撃： ${foe.name} に ${atk.atk} ダメージ`);
  } else {
    const tf = foe.field.find(f => f.uid === target.uid);
    if (!tf) return { error: '対象のフォロワーがいません' };
    if (wards.length && !CARDS[tf.defId].ward) return { error: '守護のフォロワーを攻撃しなければなりません' };
    atk.attacked = true;
    tf.hp -= atk.atk;
    atk.hp -= tf.atk;
    addLog(g, `${CARDS[atk.defId].name} の攻撃： ${CARDS[tf.defId].name} と戦闘（${atk.atk} ⇔ ${tf.atk}）`);
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
  const fresh = newGame(names[0]);
  Object.assign(g, fresh);
  startGame(g, names[1]);
}

// フォロワーの公開ビュー（場は両者とも公開情報）
function followerView(f) {
  const def = CARDS[f.defId];
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
    field: p.field.map(followerView),
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
      hand: me.hand.map(c => {
        const def = CARDS[c.defId];
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
  CARDS, DECK_LIST,
  newGame, startGame, playCard, attack, endTurn, surrender, restart, viewFor,
  // テスト用に内部関数も公開
  _internal: { makePlayer, makeCard, drawCards, startTurn, checkEnd, resolveDeaths, resolveFx },
};
