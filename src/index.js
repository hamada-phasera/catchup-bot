// ============================================================================
//  CatchUpBot ― Discord「見逃し防止ダイジェスト」ボット
//  分散情報システム 最終課題
//
//  何をするボットか:
//    1. サーバー内の発言を PostgreSQL に蓄積する。
//    2. 「@自分」宛のメンションを1件ずつ「未対応タスク」として記録する。
//    3. 返信・リアクション・同チャンネルでの発言を検知して、
//       対応済みになったものを自動的にタスクから外す（ここは生成AIではなく素のロジック）。
//    4. 毎朝 決まった時刻に、前日の各チャンネルの流れを Gemini に要約させ、
//       「あなた宛の未対応 n 件」と一緒に DM で届ける。
//
//  設計方針:
//    - Gemini は「長い雑談ログを短くする」ためだけに使う。
//      誰宛か・対応済みかの判定は Discord のイベント（返信/リアクション）と
//      PostgreSQL の履歴で行うので、生成AIが落ちてもボットは機能する。
// ============================================================================

import express from 'express';
import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
} from 'discord.js';
import { GoogleGenAI } from '@google/genai';
import { DataTypes, Op, Sequelize } from 'sequelize';
import 'dotenv/config';

if (!process.env.DISCORD_TOKEN) {
  throw new Error('DISCORD_TOKEN が設定されていません。');
}
if (!process.env.DB_INFO) {
  throw new Error('DB_INFO が設定されていません。');
}

// ===== 定数 =====
const GEMINI_MODEL = 'gemini-3-flash-preview';
// メンションされた本人が同じチャンネルでこの時間内に発言したら「対応した」とみなす。
const AUTO_DONE_MINUTES = 30;
// 要約のために Gemini へ渡す1チャンネルあたりの最大発言数。
const MAX_LOG_PER_CHANNEL = 60;
// ダイジェストに載せる未対応メンションの最大件数。
const MAX_TODO_IN_DIGEST = 10;

// ============================================================================
//  データベース
// ============================================================================
const sequelize = new Sequelize(process.env.DB_INFO, {
  dialect: 'postgres',
  logging: false,
  // Render の PostgreSQL は SSL 接続を要求するため、外部URLの場合だけ SSL を有効にする。
  dialectOptions: process.env.DB_INFO.includes('render.com')
    ? { ssl: { require: true, rejectUnauthorized: false } }
    : {},
});

// 蓄積した発言。日次ダイジェストの材料になる。
const Message = sequelize.define(
  'messages',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    guild_id: DataTypes.STRING,
    channel_id: DataTypes.STRING,
    channel_name: DataTypes.STRING,
    message_id: { type: DataTypes.STRING, unique: true },
    author_id: DataTypes.STRING,
    author_name: DataTypes.STRING,
    content: DataTypes.TEXT,
    posted_at: DataTypes.DATE,
  },
  { freezeTableName: true, indexes: [{ fields: ['guild_id', 'posted_at'] }] }
);

// 「@誰か」宛のメンション1件＝タスク1件。status で未対応/対応済みを管理する。
const Mention = sequelize.define(
  'mentions',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    guild_id: DataTypes.STRING,
    channel_id: DataTypes.STRING,
    channel_name: DataTypes.STRING,
    message_id: DataTypes.STRING,
    target_user_id: DataTypes.STRING,
    author_name: DataTypes.STRING,
    content: DataTypes.TEXT,
    jump_url: DataTypes.STRING,
    status: { type: DataTypes.STRING, defaultValue: 'pending' },
    done_reason: DataTypes.STRING,
    posted_at: DataTypes.DATE,
  },
  { freezeTableName: true, indexes: [{ fields: ['target_user_id', 'status'] }] }
);

// 毎朝の配信を希望しているユーザー。
const Subscription = sequelize.define(
  'subscriptions',
  {
    user_id: { type: DataTypes.STRING, primaryKey: true },
    guild_id: DataTypes.STRING,
    hour: { type: DataTypes.INTEGER, defaultValue: 8 },
    minute: { type: DataTypes.INTEGER, defaultValue: 0 },
    // 二重配信を防ぐため、最後に送った日付（YYYY-MM-DD）を持つ。
    last_sent_on: DataTypes.STRING,
  },
  { freezeTableName: true }
);

// PostgreSQL は起動直後すぐ接続を受け付けないことがあるので、数回リトライする。
async function initDatabase() {
  for (let i = 1; i <= 10; i++) {
    try {
      await sequelize.authenticate();
      await sequelize.sync({ alter: true });
      console.log('データベースに接続し、テーブルを同期しました');
      return;
    } catch (error) {
      console.log(`DB接続待ち... (${i}/10) ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  throw new Error('データベースに接続できませんでした');
}

// ============================================================================
//  Gemini（要約担当）
// ============================================================================
const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

// チャンネルごとの発言ログをまとめて Gemini に渡し、箇条書きの要約を作らせる。
async function summarizeLogs(logsByChannel) {
  const body = Object.entries(logsByChannel)
    .map(([channelName, rows]) => {
      const lines = rows
        .slice(-MAX_LOG_PER_CHANNEL)
        .map((row) => `${row.author_name}: ${row.content.replace(/\n/g, ' ')}`)
        .join('\n');
      return `## #${channelName}\n${lines}`;
    })
    .join('\n\n');

  const prompt =
    'あなたはチームの書記です。以下は Discord サーバーの一定期間の発言ログです。\n' +
    '見逃した人が短時間で状況を把握できるように、チャンネルごとに要約してください。\n' +
    '条件:\n' +
    '- チャンネルごとに「#チャンネル名」の見出しを付け、その下に箇条書きで最大3行。\n' +
    '- 決まったこと・告知・依頼・変更点を優先し、雑談や挨拶は書かない。\n' +
    '- 書くことが無いチャンネルは「特になし」とだけ書く。\n' +
    '- 事実だけを書き、ログに無い情報を推測で足さない。\n' +
    '- 日本語のプレーンテキストで出力し、前置きや結びの文は書かない。\n\n' +
    `--- ログここから ---\n${body}\n--- ログここまで ---`;

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
  });
  return response.text?.trim();
}

// Gemini が使えない/失敗したときでもダイジェストを止めないための代替要約。
// 生成AIに依存せず、チャンネルごとの件数と発言者だけを機械的にまとめる。
function summarizeWithoutAi(logsByChannel) {
  return Object.entries(logsByChannel)
    .map(([channelName, rows]) => {
      const names = [...new Set(rows.map((row) => row.author_name))].slice(0, 5);
      return `#${channelName}\n・${rows.length}件の発言（${names.join(', ')}）`;
    })
    .join('\n');
}

// ============================================================================
//  ダイジェストの組み立てと送信
// ============================================================================

// 指定ユーザー向けに、直近 hours 時間分のダイジェストを作って DM する。
// 戻り値はログ表示用の短い文字列。
async function sendDigest(user, guildId, hours) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const rows = await Message.findAll({
    where: { guild_id: guildId, posted_at: { [Op.gte]: since } },
    order: [['posted_at', 'ASC']],
  });

  // 自分の未対応メンションは、期間に関係なく残っているものを全部出す。
  const todos = await Mention.findAll({
    where: { guild_id: guildId, target_user_id: user.id, status: 'pending' },
    order: [['posted_at', 'ASC']],
  });

  if (rows.length === 0 && todos.length === 0) {
    await user.send(`直近${hours}時間、新しい動きはありませんでした。`);
    return '動きなし';
  }

  // チャンネルごとにログをまとめる。自分の発言は要約に含めない（自分は知っているため）。
  const logsByChannel = {};
  for (const row of rows) {
    if (row.author_id === user.id) continue;
    if (!row.content) continue;
    (logsByChannel[row.channel_name] ||= []).push(row);
  }

  let summary;
  if (Object.keys(logsByChannel).length === 0) {
    summary = '他の人の新しい発言はありませんでした。';
  } else if (ai) {
    try {
      summary = await summarizeLogs(logsByChannel);
    } catch (error) {
      console.error('Gemini 要約に失敗しました:', error.message);
    }
  }
  if (!summary) {
    summary = summarizeWithoutAi(logsByChannel) + '\n（要約AIが利用できないため簡易表示）';
  }

  const embed = new EmbedBuilder()
    .setTitle(`直近${hours}時間のまとめ`)
    .setColor(0x5865f2)
    .setDescription(summary.slice(0, 4000))
    .setFooter({ text: `対象の発言 ${rows.length}件 / 未対応 ${todos.length}件` })
    .setTimestamp(new Date());

  if (todos.length > 0) {
    const list = todos
      .slice(0, MAX_TODO_IN_DIGEST)
      .map((todo, index) => {
        const text = todo.content.replace(/\n/g, ' ').slice(0, 80);
        return `**${index + 1}.** ${todo.author_name}（#${todo.channel_name}）\n${text}\n[メッセージへ移動](${todo.jump_url})`;
      })
      .join('\n\n');
    const extra = todos.length > MAX_TODO_IN_DIGEST ? `\n\nほか${todos.length - MAX_TODO_IN_DIGEST}件` : '';
    embed.addFields({ name: `あなた宛の未対応 ${todos.length}件`, value: (list + extra).slice(0, 1024) });
  }

  await user.send({ embeds: [embed], components: buildDoneButtons(todos) });
  return `発言${rows.length}件 / 未対応${todos.length}件`;
}

// 未対応メンションを「対応済み」にするボタンを組み立てる（1行5個まで）。
function buildDoneButtons(todos) {
  if (todos.length === 0) return [];
  const buttons = todos.slice(0, 5).map((todo, index) =>
    new ButtonBuilder()
      .setCustomId(`done:${todo.id}`)
      .setLabel(`${index + 1} を対応済みにする`)
      .setStyle(ButtonStyle.Secondary)
  );
  return [new ActionRowBuilder().addComponents(buttons)];
}

// ============================================================================
//  Discord クライアント
// ============================================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  // キャッシュに無い古いメッセージへのリアクションも受け取れるようにする。
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const HELP_TEXT =
  '**CatchUpBot の使い方**\n' +
  'しばらく Discord を見られなかった人のために、サーバーの流れを要約し、' +
  '自分宛のメンションのうち「まだ返していないもの」だけを抜き出して DM で届けるボットです。\n\n' +
  '**/help** … この説明を表示します。\n' +
  '**/catchup [hours]** … 直近 hours 時間（既定24、1〜168）のまとめを今すぐ DM で受け取ります。\n' +
  '**/subscribe [time]** … 毎日決まった時刻に自動配信します（例: `/subscribe time:08:00`）。\n' +
  '**/unsubscribe** … 自動配信を止めます。\n' +
  '**/todo** … 自分宛の未対応メンション一覧を表示します（自分にだけ見えます）。\n\n' +
  '**未対応かどうかの判定**\n' +
  '・そのメッセージに返信した → 対応済み\n' +
  `・そのメッセージにリアクションを付けた → 対応済み\n` +
  `・同じチャンネルで${AUTO_DONE_MINUTES}分以内に発言した → 対応済み\n` +
  '・上のどれでもない場合は、ボタンか `/todo` から手動で対応済みにできます。\n\n' +
  '※ 発言内容はダイジェスト作成のためにこのサーバー内のみで保存されます。';

// ----- 起動時: スラッシュコマンドを登録 -----
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`${readyClient.user.tag} としてログインしました`);
  await readyClient.application.commands.set([
    { name: 'help', description: 'CatchUpBot の使い方を表示します' },
    {
      name: 'catchup',
      description: '見ていなかった間のサーバーのまとめを DM で受け取ります',
      options: [
        {
          name: 'hours',
          description: '何時間前まで遡るか（既定24）',
          type: ApplicationCommandOptionType.Integer,
          required: false,
          minValue: 1,
          maxValue: 168,
        },
      ],
    },
    {
      name: 'subscribe',
      description: '毎日決まった時刻にまとめを自動配信します',
      options: [
        {
          name: 'time',
          description: '配信時刻 HH:MM（既定 08:00）',
          type: ApplicationCommandOptionType.String,
          required: false,
        },
      ],
    },
    { name: 'unsubscribe', description: '自動配信を停止します' },
    { name: 'todo', description: '自分宛の未対応メンションを表示します' },
  ]);
  console.log('スラッシュコマンドを登録しました');
});

// ----- 発言の記録とメンションの検出 -----
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  try {
    await Message.create({
      guild_id: message.guild.id,
      channel_id: message.channel.id,
      channel_name: message.channel.name ?? 'unknown',
      message_id: message.id,
      author_id: message.author.id,
      author_name: message.member?.displayName ?? message.author.username,
      content: message.content ?? '',
      posted_at: message.createdAt,
    });

    // (1) 自分以外の人間へのメンションを未対応タスクとして登録する。
    //     @everyone / @here は全員宛なので個人タスクにはしない。
    if (!message.mentions.everyone) {
      for (const target of message.mentions.users.values()) {
        if (target.bot || target.id === message.author.id) continue;
        await Mention.create({
          guild_id: message.guild.id,
          channel_id: message.channel.id,
          channel_name: message.channel.name ?? 'unknown',
          message_id: message.id,
          target_user_id: target.id,
          author_name: message.member?.displayName ?? message.author.username,
          content: message.content ?? '',
          jump_url: message.url,
          posted_at: message.createdAt,
        });
        console.log(`未対応を登録: ${target.username} <- ${message.author.username}`);
      }
    }

    // (2) この発言が「返信」なら、返信先のメンションを対応済みにする。
    if (message.reference?.messageId) {
      await resolveMentions(
        { message_id: message.reference.messageId, target_user_id: message.author.id },
        '返信した'
      );
    }

    // (3) メンションされた本人が同じチャンネルで一定時間内に発言したら対応済みとみなす。
    //     Discord では返信機能を使わずそのまま書くことが多いため、この救済を入れている。
    await resolveMentions(
      {
        channel_id: message.channel.id,
        target_user_id: message.author.id,
        posted_at: { [Op.gte]: new Date(Date.now() - AUTO_DONE_MINUTES * 60 * 1000) },
      },
      '同じチャンネルで発言した'
    );
  } catch (error) {
    console.error('メッセージ処理でエラー:', error.message);
  }
});

// 条件に合う未対応メンションをまとめて対応済みにする。
async function resolveMentions(where, reason) {
  const [count] = await Mention.update(
    { status: 'done', done_reason: reason },
    { where: { ...where, status: 'pending' } }
  );
  if (count > 0) console.log(`${count}件を対応済みにしました（${reason}）`);
  return count;
}

// ----- リアクションによる「対応済み」判定 -----
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;
  try {
    if (reaction.partial) await reaction.fetch();
    await resolveMentions(
      { message_id: reaction.message.id, target_user_id: user.id },
      'リアクションを付けた'
    );
  } catch (error) {
    console.error('リアクション処理でエラー:', error.message);
  }
});

// ----- スラッシュコマンドとボタンの処理 -----
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      await handleButton(interaction);
      return;
    }
    if (!interaction.isChatInputCommand()) return;

    switch (interaction.commandName) {
      case 'help':
        await interaction.reply({ content: HELP_TEXT, flags: MessageFlags.Ephemeral });
        break;
      case 'catchup':
        await handleCatchup(interaction);
        break;
      case 'subscribe':
        await handleSubscribe(interaction);
        break;
      case 'unsubscribe':
        await Subscription.destroy({ where: { user_id: interaction.user.id } });
        await interaction.reply({ content: '自動配信を停止しました。', flags: MessageFlags.Ephemeral });
        break;
      case 'todo':
        await handleTodo(interaction);
        break;
    }
  } catch (error) {
    console.error('インタラクション処理でエラー:', error.message);
    const body = { content: 'エラーが発生しました。時間をおいて試してください。', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(body).catch(() => {});
    } else {
      await interaction.reply(body).catch(() => {});
    }
  }
});

async function handleCatchup(interaction) {
  if (!interaction.guildId) {
    await interaction.reply({ content: 'サーバーのチャンネルで実行してください。', flags: MessageFlags.Ephemeral });
    return;
  }
  // Gemini の要約に数秒かかるので、先に「考え中」の状態にしておく。
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const hours = interaction.options.getInteger('hours') ?? 24;
  try {
    const result = await sendDigest(interaction.user, interaction.guildId, hours);
    await interaction.editReply(`DM にまとめを送りました。（${result}）`);
  } catch (error) {
    console.error('ダイジェスト送信に失敗:', error.message);
    await interaction.editReply('DM を送れませんでした。プライバシー設定でサーバーからの DM を許可してください。');
  }
}

async function handleSubscribe(interaction) {
  if (!interaction.guildId) {
    await interaction.reply({ content: 'サーバーのチャンネルで実行してください。', flags: MessageFlags.Ephemeral });
    return;
  }
  const input = interaction.options.getString('time') ?? '08:00';
  const matched = input.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!matched) {
    await interaction.reply({
      content: '時刻は `08:00` のような HH:MM 形式で指定してください。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  await Subscription.upsert({
    user_id: interaction.user.id,
    guild_id: interaction.guildId,
    hour,
    minute,
    last_sent_on: null,
  });
  await interaction.reply({
    content: `毎日 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} にまとめを DM します。`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleTodo(interaction) {
  const todos = await Mention.findAll({
    where: { guild_id: interaction.guildId, target_user_id: interaction.user.id, status: 'pending' },
    order: [['posted_at', 'ASC']],
  });
  if (todos.length === 0) {
    await interaction.reply({ content: '未対応のメンションはありません。', flags: MessageFlags.Ephemeral });
    return;
  }
  const embed = new EmbedBuilder()
    .setTitle(`未対応のメンション ${todos.length}件`)
    .setColor(0xed4245)
    .setDescription(
      todos
        .slice(0, MAX_TODO_IN_DIGEST)
        .map((todo, index) => {
          const text = todo.content.replace(/\n/g, ' ').slice(0, 80);
          return `**${index + 1}.** ${todo.author_name}（#${todo.channel_name}）\n${text}\n[メッセージへ移動](${todo.jump_url})`;
        })
        .join('\n\n')
        .slice(0, 4000)
    );
  await interaction.reply({
    embeds: [embed],
    components: buildDoneButtons(todos),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleButton(interaction) {
  const [action, id] = interaction.customId.split(':');
  if (action !== 'done') return;
  const mention = await Mention.findByPk(Number(id));
  // 他人のタスクを勝手に閉じられないようにする。
  if (!mention || mention.target_user_id !== interaction.user.id) {
    await interaction.reply({ content: 'この項目は操作できません。', flags: MessageFlags.Ephemeral });
    return;
  }
  await mention.update({ status: 'done', done_reason: 'ボタンで手動' });
  await interaction.reply({
    content: `「${mention.content.slice(0, 40)}」を対応済みにしました。`,
    flags: MessageFlags.Ephemeral,
  });
}

// ============================================================================
//  定期配信
//  Render の無料プランはアクセスが無いとスリープし、その間タイマーは止まる。
//  そこで「毎分、配信時刻を過ぎていて今日まだ送っていない人を探す」方式にしてある。
//  スリープから復帰した時点で、その日の未配信ぶんがまとめて届く。
// ============================================================================
function todayString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

async function runScheduler() {
  const now = new Date();
  const today = todayString();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const subscriptions = await Subscription.findAll({
    where: { last_sent_on: { [Op.or]: [{ [Op.ne]: today }, { [Op.is]: null }] } },
  });

  for (const subscription of subscriptions) {
    if (subscription.hour * 60 + subscription.minute > nowMinutes) continue;
    try {
      const user = await client.users.fetch(subscription.user_id);
      const result = await sendDigest(user, subscription.guild_id, 24);
      console.log(`定期配信: ${user.username} へ送信（${result}）`);
    } catch (error) {
      console.error(`定期配信に失敗 (${subscription.user_id}):`, error.message);
    }
    // 失敗しても当日は再送しない（毎分エラーを繰り返さないため）。
    await subscription.update({ last_sent_on: today });
  }
}

// ============================================================================
//  Web サーバー（Render のポート待ち受け＋スリープ解除用ページ）
// ============================================================================
const app = express();

app.get('/', async (request, response) => {
  let stats = { messages: 0, pending: 0, subscriptions: 0 };
  try {
    stats = {
      messages: await Message.count(),
      pending: await Mention.count({ where: { status: 'pending' } }),
      subscriptions: await Subscription.count(),
    };
  } catch (error) {
    console.error('統計の取得に失敗:', error.message);
  }

  response.send(`<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><title>CatchUpBot</title>
<style>
  body { font-family: sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; line-height: 1.8; }
  .ok { color: #2e7d32; font-weight: bold; }
  table { border-collapse: collapse; margin-top: 16px; }
  th, td { border: 1px solid #ccc; padding: 6px 16px; text-align: left; }
</style></head>
<body>
  <h1>CatchUpBot</h1>
  <p>状態: <span class="ok">${client.isReady() ? '稼働中' : '起動中'}</span>
     ${client.user ? `（${client.user.tag}）` : ''}</p>
  <p>このページを開くと Render のスリープが解除され、ボットが応答するようになります。</p>
  <table>
    <tr><th>蓄積した発言</th><td>${stats.messages} 件</td></tr>
    <tr><th>未対応メンション</th><td>${stats.pending} 件</td></tr>
    <tr><th>自動配信の登録者</th><td>${stats.subscriptions} 人</td></tr>
    <tr><th>サーバー時刻</th><td>${new Date().toLocaleString('ja-JP')}</td></tr>
  </table>
  <p>Discord で <code>/help</code> と入力すると使い方が表示されます。</p>
</body></html>`);
});

// ============================================================================
//  起動
// ============================================================================
await initDatabase();
await client.login(process.env.DISCORD_TOKEN);

setInterval(() => {
  runScheduler().catch((error) => console.error('スケジューラでエラー:', error.message));
}, 60 * 1000);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Web サーバーを起動しました (port ${port})`));
