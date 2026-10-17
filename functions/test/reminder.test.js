const test = require("node:test");
const assert = require("node:assert/strict");
const { buildReminderMessages } = require("../reminder");

test("当日はリマインドと正確な点数入力リンクを別メッセージで返す", () => {
  assert.deepEqual(buildReminderMessages(0, "10/17(土)", "19:00〜22:00"), [
    {
      type: "text",
      text: "🔔 リマインド: 今日 10/17(土) 19:00〜22:00 はポーカーです!🃏",
    },
    {
      type: "text",
      text: "点数入力はこちら\nhttps://poker-tracker.1210hatanaka.workers.dev/?openExternalBrowser=1&v=2#/sessions",
    },
  ]);
});

for (const [days, label] of [[3, "3日後"], [1, "明日"]]) {
  test(`${days}日前はリマインドだけを返す`, () => {
    assert.deepEqual(buildReminderMessages(days, "10/17(土)", "19:00〜22:00"), [{
      type: "text",
      text: `🔔 リマインド: ${label} 10/17(土) 19:00〜22:00 はポーカーです!🃏`,
    }]);
  });
}

test("過去の日付や通知対象外の日にはメッセージを返さない", () => {
  for (const days of [-3, -1, 2, 4, 30]) {
    assert.deepEqual(buildReminderMessages(days, "10/17(土)", "19:00〜22:00"), []);
  }
});
