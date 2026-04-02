const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
} = require("discord.js");

const { MongoClient } = require("mongodb");

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const activities = require("./activities.json");

// ─── CONFIG ─────────────────────────────
const CHANNEL_ID             = process.env.CHANNEL_ID;
const ROLE_ID                = process.env.ROLE_ID;
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID || CHANNEL_ID;

// ─── MONGODB ───────────────────────────
const mongoClient = new MongoClient(process.env.MONGO_URI);
let db;

async function connectDB() {
  await mongoClient.connect();
  db = mongoClient.db("discordBot");
  console.log("🔥 MongoDB conectado");
}

// ─── DB FUNCIONES ──────────────────────

// Guardar actividad (UNA por click)
async function registrarCompletacion(user) {
  const collection = db.collection("activityLogs");

  await collection.insertOne({
    userId: user.id,
    username: user.tag,
    createdAt: new Date(),
  });
}

// Obtener inicio de semana (sábado 7PM Colombia)
function getWeekRange() {
  const now = new Date();

  // Ajuste Colombia (UTC-5)
  const colombiaNow = new Date(now.getTime() - (5 * 60 * 60 * 1000));

  const day = colombiaNow.getDay(); // 0 domingo
  const diffToSaturday = (day + 1) % 7;

  const saturday = new Date(colombiaNow);
  saturday.setDate(colombiaNow.getDate() - diffToSaturday);
  saturday.setHours(19, 0, 0, 0);

  const start = new Date(saturday.getTime() + (5 * 60 * 60 * 1000)); // volver a UTC
  const end = new Date(start);
  end.setDate(start.getDate() + 7);

  return { start, end };
}

// TOP semanal REAL
async function getWeeklyTop() {
  const { start, end } = getWeekRange();

  const collection = db.collection("activityLogs");

  const top = await collection.aggregate([
    {
      $match: {
        createdAt: { $gte: start, $lt: end }
      }
    },
    {
      $group: {
        _id: "$userId",
        count: { $sum: 1 },
        username: { $last: "$username" }
      }
    },
    {
      $sort: { count: -1 }
    },
    {
      $limit: 10
    }
  ]).toArray();

  return top;
}

// ─── READY ─────────────────────────────
client.once("clientReady", async () => {
  console.log(`✅ ${client.user.tag} listo`);

  await connectDB();

  setInterval(checkActivities, 60 * 1000);
});

// ─── INTERACCIONES ─────────────────────
client.on("interactionCreate", async (interaction) => {

  if (interaction.isChatInputCommand()) {

    if (interaction.commandName === "testactivity") {
      const activity = activities[Math.floor(Math.random() * activities.length)];
      await sendActivityEmbed(interaction, activity, true);
    }

    if (interaction.commandName === "topleaderboard") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
          content: "❌ Solo admins",
          ephemeral: true
        });
      }

      await interaction.deferReply({ ephemeral: true });

      await enviarLeaderboard(interaction.channel, true);

      await interaction.editReply({
        content: "✅ Top enviado"
      });
    }
  }

  // BOTÓN
  if (interaction.isButton()) {
    await interaction.deferUpdate();

    if (interaction.message.components.length === 0) return;

    const embed = interaction.message.embeds[0];
    if (!embed) return;

    const activityName = embed.title.replace("🚨 ", "");

    const completed = EmbedBuilder.from(embed)
      .setColor("#2ecc71")
      .setDescription(
        `✅ **Actividad de ${activityName} completada por ${interaction.user}**`
      );

    await interaction.message.edit({
      embeds: [completed],
      components: [],
    });

    await registrarCompletacion(interaction.user);
  }
});

// ─── CHECK ACTIVITIES ──────────────────
async function checkActivities() {
  const now = new Date();

  let hours = now.getUTCHours() - 5;
  const minutes = now.getUTCMinutes();
  if (hours < 0) hours += 24;

  for (const activity of activities) {
    const [hour, minute] = activity.time.split(":").map(Number);

    if (hours === hour && minutes === minute) {
      await sendActivityEmbed(null, activity, false);
    }
  }

  // Enviar top semanal automáticamente
  const utcDay = now.getUTCDay();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();

  if (utcDay === 0 && utcH === 0 && utcM === 0) {
    const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    await enviarLeaderboard(channel, false);
  }
}

// ─── LEADERBOARD ───────────────────────
async function enviarLeaderboard(channel, isPreview) {
  const top = await getWeeklyTop();

  let description;

  if (top.length === 0) {
    description = "😔 Nadie participó esta semana.";
  } else {
    const medals = ["🥇", "🥈", "🥉"];

    description = top.map((user, i) => {
      const prefix = medals[i] || `**${i + 1}.**`;
      return `${prefix} <@${user._id}> — **${user.count}** actividades`;
    }).join("\n");
  }

  const { start, end } = getWeekRange();

  const embed = new EmbedBuilder()
    .setColor("#f1c40f")
    .setTitle("🏆 Top semanal")
    .setDescription(description)
    .addFields({
      name: "📅 Período",
      value: `<t:${Math.floor(start.getTime()/1000)}:D> → <t:${Math.floor(end.getTime()/1000)}:D>`
    })
    .setFooter({
      text: isPreview ? "Vista previa" : "Actualizado automáticamente"
    });

  await channel.send({ embeds: [embed] });
}

// ─── ACTIVIDAD ─────────────────────────
async function sendActivityEmbed(interaction, activity, isTest) {
  const embed = new EmbedBuilder()
    .setColor("#0099ff")
    .setTitle(`🚨 ${activity.name}`)
    .setDescription(`📢 **${activity.description}**`)
    .addFields({
      name: "🕒 Horario",
      value: `**${activity.time}**`,
      inline: true,
    })
    .setImage(activity.image);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`complete_${activity.name}_${activity.time}`)
      .setLabel("Completar actividad")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
  );

  if (isTest) {
    await interaction.reply({
      content: "🧪 Test",
      embeds: [embed],
      components: [row],
    });
  } else {
    const channel = await client.channels.fetch(CHANNEL_ID);

    await channel.send({
      content: `<@&${ROLE_ID}>`,
      embeds: [embed],
      components: [row],
    });
  }
}

// ─── COMMANDS ─────────────────────────
const commands = [
  {
    name: "testactivity",
    description: "Simula una actividad",
  },
  {
    name: "topleaderboard",
    description: "Ver top semanal",
  },
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID),
    { body: commands }
  );
  console.log("✅ Commands listos");
})();

client.login(process.env.DISCORD_TOKEN);