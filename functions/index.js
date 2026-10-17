/**
 * LINE ポーカー幹事Bot
 * - 毎月: 輪番の幹事をメンションし、日程調整(人力)を促す
 * - 開催日: 幹事が「@poker 開催日 8/8」で登録
 * - リマインド: 開催3日前・前日・当日にプッシュ。当日は別メッセージで点数入力先を案内
 * - 点数: 「@poker 結果 ...」で記録、「@poker ランキング」で累積表示
 */

const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const line = require("@line/bot-sdk");
const { buildReminderMessages } = require("./reminder");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// ===== 設定 =====
const TZ = "Asia/Tokyo";
const EVENT_TIME = "19:00〜22:00"; // 開催時刻(固定)
const ANNOUNCE_DAY = 20;           // 毎月20日に翌月の幹事をアナウンス
const CHANNEL_ACCESS_TOKEN = defineSecret("LINE_CHANNEL_ACCESS_TOKEN");
const CHANNEL_SECRET = defineSecret("LINE_CHANNEL_SECRET");

const WEEKDAY_JP = ["日", "月", "火", "水", "木", "金", "土"];

function lineClient() {
  return new line.messagingApi.MessagingApiClient({
    channelAccessToken: CHANNEL_ACCESS_TOKEN.value(),
  });
}

// ===== 日付ユーティリティ(JST基準) =====
function nowJST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function fmtDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = WEEKDAY_JP[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d}(${dow})`;
}

/**
 * "8/8" or "2026-08-08" → "YYYY-MM-DD"。不正ならnull
 * rollForward=true: M/D形式を今日以降の直近の日付に解釈(開催日用)
 * rollForward=false: M/D形式を今年の日付として解釈(過去の結果記録用)
 */
function parseDateArg(arg, rollForward = true) {
  if (!arg) return null;
  let y, m, d;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(arg)) {
    [y, m, d] = arg.split("-").map(Number);
  } else if (/^\d{1,2}\/\d{1,2}$/.test(arg)) {
    [m, d] = arg.split("/").map(Number);
    const now = nowJST();
    y = now.getUTCFullYear();
    if (rollForward) {
      const today = now.toISOString().slice(0, 10);
      const candidate = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (candidate < today) y += 1;
    }
  } else {
    return null;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** 1日1人1レコード。同じ日・同じ名前の再記録は上書きになる */
function gameRef(iso, name) {
  return db.doc(`games/${iso}_${name.replace(/\//g, "_")}`);
}

// ===== グループID管理 =====
async function getGroupId() {
  const doc = await db.doc("config/group").get();
  return doc.exists ? doc.data().groupId : null;
}

async function saveGroupId(groupId) {
  await db.doc("config/group").set({ groupId }, { merge: true });
}

// ===== 幹事の輪番 =====
async function getOrganizers() {
  const doc = await db.doc("config/organizers").get();
  return doc.exists ? doc.data() : { rotation: [], index: 0 };
}

async function getMembers() {
  const doc = await db.doc("config/members").get();
  return doc.exists ? doc.data() : {};
}

/** 現在の担当者の名前と(登録済みなら)userIdを返す */
async function currentOrganizer() {
  const { rotation = [], index = 0 } = await getOrganizers();
  if (rotation.length === 0) return null;
  const name = rotation[index % rotation.length];
  const members = await getMembers();
  return { name, userId: members[name] || null };
}

/** userIdがあればメンション付きtextV2、なければ平文のメッセージを作る */
function buildMentionMessage(organizer, textAfterName) {
  if (organizer.userId) {
    return {
      type: "textV2",
      text: `{user} さん${textAfterName}`,
      substitution: {
        user: {
          type: "mention",
          mentionee: { type: "user", userId: organizer.userId },
        },
      },
    };
  }
  return { type: "text", text: `@${organizer.name} さん${textAfterName}` };
}

// ===== ① Webhook =====
exports.webhook = onRequest(
  { region: "asia-northeast1", secrets: [CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET] },
  async (req, res) => {
    // 署名検証
    const signature = req.headers["x-line-signature"];
    if (typeof signature !== "string" || !line.validateSignature(req.rawBody, CHANNEL_SECRET.value(), signature)) {
      res.status(403).send("invalid signature");
      return;
    }

    const client = lineClient();
    const events = req.body.events || [];

    await Promise.all(
      events.map(async (ev) => {
        try {
          // グループ参加時にIDを保存
          if (ev.type === "join" && ev.source.type === "group") {
            await saveGroupId(ev.source.groupId);
            await client.replyMessage({
              replyToken: ev.replyToken,
              messages: [{ type: "text", text: "🃏 ポーカー幹事Botです!\n毎月20日に翌月の幹事(輪番)をお知らせします。\nコマンド一覧は「@poker ヘルプ」" }],
            });
            return;
          }

          if (ev.source.type === "group" && !(await getGroupId())) {
            await saveGroupId(ev.source.groupId);
          }

          if (ev.type === "message" && ev.message.type === "text") {
            await handleText(client, ev);
          }
        } catch (e) {
          console.error("event error", e);
        }
      })
    );
    res.status(200).send("ok");
  }
);

// ===== テキストコマンド処理 =====
async function handleText(client, ev) {
  const text = ev.message.text.trim();
  if (!text.startsWith("@poker")) return;
  const args = text.split(/\s+/).slice(1);
  const cmd = args[0] || "ヘルプ";

  const reply = (messages) =>
    client.replyMessage({ replyToken: ev.replyToken, messages });

  // 「@poker 1000」のように数値だけなら自分の点数として記録
  if (/^[+-]?\d+$/.test(cmd)) {
    await recordMyScore(client, ev, parseInt(cmd, 10));
    return;
  }

  switch (cmd) {
    case "ヘルプ": {
      await reply([{
        type: "text",
        text: [
          "🃏 コマンド一覧",
          "@poker 幹事 … 今の担当者を表示",
          "@poker 幹事登録 太郎 花子 次郎 … 輪番リストを設定",
          "@poker 登録 太郎 … 自分をその名前に紐づけ(メンション用)",
          "@poker 開催日 8/8 … 開催日を登録(リマインド対象)",
          "@poker 今月 … 登録済みの開催日を表示",
          "@poker 1000 … 自分の点数を記録(同日の再入力は上書き)",
          "@poker 結果 8/8 太郎 500 花子 300 … まとめて点数を記録",
          "@poker ランキング … 累積ランキング",
        ].join("\n"),
      }]);
      break;
    }

    case "幹事": {
      const organizer = await currentOrganizer();
      if (!organizer) {
        await reply([{ type: "text", text: "輪番リストが未設定です。「@poker 幹事登録 太郎 花子 次郎」で設定してください" }]);
        return;
      }
      const { rotation, index } = await getOrganizers();
      const order = rotation
        .map((n, i) => (i === index % rotation.length ? `▶ ${n}` : `・${n}`))
        .join("\n");
      await reply([{ type: "text", text: `👤 今の幹事: ${organizer.name} さん\n\n輪番リスト:\n${order}` }]);
      break;
    }

    case "幹事登録": {
      const names = args.slice(1);
      if (names.length === 0) {
        await reply([{ type: "text", text: "書式: @poker 幹事登録 太郎 花子 次郎(輪番の順に名前を並べてください)" }]);
        return;
      }
      await db.doc("config/organizers").set({ rotation: names, index: 0 });
      await reply([{ type: "text", text: `✅ 輪番リストを設定しました\n${names.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\n先頭の ${names[0]} さんから順番に回ります` }]);
      break;
    }

    case "登録": {
      const name = args[1];
      if (!name) {
        await reply([{ type: "text", text: "書式: @poker 登録 太郎(輪番リストと同じ名前を指定してください)" }]);
        return;
      }
      if (!ev.source.userId) {
        await reply([{ type: "text", text: "ユーザーIDが取得できませんでした" }]);
        return;
      }
      await db.doc("config/members").set({ [name]: ev.source.userId }, { merge: true });
      await reply([{ type: "text", text: `✅ ${name} さんとして登録しました。幹事の番が来たらメンションでお知らせします` }]);
      break;
    }

    case "開催日": {
      const date = parseDateArg(args[1]);
      if (!date) {
        await reply([{ type: "text", text: "書式: @poker 開催日 8/8(または 2026-08-08)" }]);
        return;
      }
      await db.doc("config/nextEvent").set({
        date,
        setBy: ev.source.userId || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await reply([{ type: "text", text: `📅 開催日を ${fmtDate(date)} ${EVENT_TIME} に登録しました!\n3日前・前日・当日の朝9時にリマインドします🔔` }]);
      break;
    }

    case "今月": {
      const doc = await db.doc("config/nextEvent").get();
      const today = nowJST().toISOString().slice(0, 10);
      if (!doc.exists || !doc.data().date || doc.data().date < today) {
        await reply([{ type: "text", text: "登録済みの開催日はありません。幹事さんは日程が決まったら「@poker 開催日 8/8」で登録してください" }]);
        return;
      }
      await reply([{ type: "text", text: `📅 次回開催: ${fmtDate(doc.data().date)} ${EVENT_TIME}` }]);
      break;
    }

    case "結果": {
      // 例: @poker 結果 8/8 太郎 500 花子 300(素点で記録。厳密な管理はNotion側)
      const iso = parseDateArg(args[1], false);
      const pairs = [];
      for (let i = 2; i + 1 < args.length + 1; i += 2) {
        if (args[i] && args[i + 1]) pairs.push([args[i], parseInt(args[i + 1], 10)]);
      }
      if (!iso || pairs.length === 0 || pairs.some(([, p]) => isNaN(p))) {
        await reply([{ type: "text", text: "書式: @poker 結果 8/8 太郎 500 花子 300" }]);
        return;
      }
      const batch = db.batch();
      for (const [player, pts] of pairs) {
        batch.set(gameRef(iso, player), {
          date: iso,
          name: player,
          points: pts,
          recordedBy: ev.source.userId || null,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
      const lines = pairs.map(([n, p]) => `${n}: ${p}点`).join("\n");
      await reply([{ type: "text", text: `✍️ ${fmtDate(iso)} の結果を記録しました\n${lines}` }]);
      break;
    }

    case "ランキング": {
      const snap = await db.collection("games").get();
      const agg = {}; // name -> { total, games }
      snap.forEach((doc) => {
        const { name, points } = doc.data();
        if (!name || typeof points !== "number") return;
        const a = (agg[name] = agg[name] || { total: 0, games: 0 });
        a.total += points;
        a.games += 1;
      });
      const entries = Object.entries(agg).sort((a, b) => b[1].total - a[1].total);
      if (entries.length === 0) {
        await reply([{ type: "text", text: "まだ記録がありません" }]);
        return;
      }
      const medals = ["🥇", "🥈", "🥉"];
      const lines = entries.map(([name, { total, games }], i) =>
        `${medals[i] || `${i + 1}.`} ${name}: ${total}点 (${games}回)`
      );
      await reply([{ type: "text", text: `🏆 累積ランキング\n${lines.join("\n")}` }]);
      break;
    }

    default:
      await reply([{ type: "text", text: "不明なコマンドです。「@poker ヘルプ」をどうぞ" }]);
  }
}

// ===== 個人の点数記録(「@poker 1000」) =====
async function recordMyScore(client, ev, pts) {
  const reply = (messages) =>
    client.replyMessage({ replyToken: ev.replyToken, messages });

  const userId = ev.source.userId;
  if (!userId) {
    await reply([{ type: "text", text: "ユーザーIDが取得できませんでした" }]);
    return;
  }

  // 名前の解決: 「@poker 登録」済みの名前 → なければLINEの表示名
  const members = await getMembers();
  let name = Object.keys(members).find((n) => members[n] === userId) || null;
  if (!name && ev.source.type === "group") {
    try {
      const prof = await client.getGroupMemberProfile(ev.source.groupId, userId);
      name = prof.displayName;
    } catch (e) {
      console.error("getGroupMemberProfile failed", e);
    }
  }
  if (!name) {
    await reply([{ type: "text", text: "名前がわかりませんでした。「@poker 登録 太郎」で名前を登録してから送ってください" }]);
    return;
  }

  const iso = nowJST().toISOString().slice(0, 10);
  const ref = gameRef(iso, name);
  const prevSnap = await ref.get();
  await ref.set({
    date: iso,
    name,
    points: pts,
    recordedBy: userId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const note = prevSnap.exists ? "(本日分を上書き)" : "";
  await reply([{ type: "text", text: `✍️ ${fmtDate(iso)} ${name}: ${pts}点 を記録しました${note}` }]);
}

// ===== ② 毎月20日 10:00 翌月の幹事をアナウンス =====
exports.announceOrganizer = onSchedule(
  {
    schedule: `0 10 ${ANNOUNCE_DAY} * *`,
    timeZone: TZ,
    region: "asia-northeast1",
    secrets: [CHANNEL_ACCESS_TOKEN],
  },
  async () => {
    const client = lineClient();
    const groupId = await getGroupId();
    if (!groupId) {
      console.error("groupId未設定: botをグループに招待してください");
      return;
    }

    const organizer = await currentOrganizer();
    if (!organizer) {
      await client.pushMessage({
        to: groupId,
        messages: [{ type: "text", text: "⚠️ 幹事の輪番リストが未設定です。「@poker 幹事登録 太郎 花子 次郎」で設定してください" }],
      });
      return;
    }

    const now = nowJST();
    const nextMonth = now.getUTCMonth() === 11 ? 1 : now.getUTCMonth() + 2;
    await client.pushMessage({
      to: groupId,
      messages: [
        buildMentionMessage(
          organizer,
          `、${nextMonth}月のポーカー幹事をお願いします!🃏\nみんなの都合を聞いて日程調整をお願いします。\n決まったら「@poker 開催日 8/8」の形式で登録してください(リマインドが有効になります)`
        ),
      ],
    });

    // 次回に備えて輪番を1つ進める
    const { rotation, index } = await getOrganizers();
    await db.doc("config/organizers").set(
      { rotation, index: (index + 1) % rotation.length },
      { merge: true }
    );
  }
);

// ===== ③ 毎日9:00 リマインド判定(3日前・前日・当日) =====
exports.remind = onSchedule(
  {
    schedule: "0 9 * * *",
    timeZone: TZ,
    region: "asia-northeast1",
    secrets: [CHANNEL_ACCESS_TOKEN],
  },
  async () => {
    const doc = await db.doc("config/nextEvent").get();
    const d = doc.exists ? doc.data().date : null;
    const today = nowJST().toISOString().slice(0, 10);
    if (!d || d < today) return;

    const diffDays = Math.round(
      (new Date(d + "T00:00:00Z") - new Date(today + "T00:00:00Z")) / 86400000
    );
    const messages = buildReminderMessages(diffDays, fmtDate(d), EVENT_TIME);
    if (messages.length === 0) return;

    const groupId = await getGroupId();
    if (!groupId) return;

    const client = lineClient();
    await client.pushMessage({
      to: groupId,
      messages,
    });
  }
);
