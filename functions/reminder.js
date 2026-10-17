const SCORE_ENTRY_URL = "https://poker-tracker.1210hatanaka.workers.dev/?openExternalBrowser=1&v=2#/sessions";

// 通知内容の組み立てを外部通信から分け、LINEへ送信せずにテストできるようにする。
function buildReminderMessages(diffDays, formattedDate, eventTime) {
  let label;
  if (diffDays === 3) label = "3日後";
  if (diffDays === 1) label = "明日";
  if (diffDays === 0) label = "今日";
  if (!label) return [];

  const messages = [{
    type: "text",
    text: `🔔 リマインド: ${label} ${formattedDate} ${eventTime} はポーカーです!🃏`,
  }];
  if (diffDays === 0) {
    messages.push({
      type: "text",
      text: `点数入力はこちら\n${SCORE_ENTRY_URL}`,
    });
  }
  return messages;
}

module.exports = { buildReminderMessages };
