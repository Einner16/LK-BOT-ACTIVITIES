const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  REST,
  Routes,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require("discord.js");

const { MongoClient } = require("mongodb");

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES HARDCODED
// ─────────────────────────────────────────────────────────────────────────────
const LOG_CHANNEL_ID = "1482558661506109530";
const OWNER_ID       = "921074538404515880";

// ─────────────────────────────────────────────────────────────────────────────
// DISCORD CLIENT
// ─────────────────────────────────────────────────────────────────────────────
const client     = new Client({ intents: [GatewayIntentBits.Guilds] });
const activities = require("./activities.json");

// ─────────────────────────────────────────────────────────────────────────────
// ENV CONFIG
// Variables requeridas en Railway:
//   DISCORD_TOKEN, CLIENT_ID, CHANNEL_ID, ROLE_ID, MONGO_URI
//   LEADERBOARD_CHANNEL_ID (opcional, usa CHANNEL_ID si no se define)
// ─────────────────────────────────────────────────────────────────────────────
const CHANNEL_ID             = process.env.CHANNEL_ID;
const ROLE_ID                = process.env.ROLE_ID;
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID || CHANNEL_ID;

// ─────────────────────────────────────────────────────────────────────────────
// MONGODB — Conexión con reintentos + reconexión automática
// ─────────────────────────────────────────────────────────────────────────────
let mongoInstance;
let db;
let isConnected   = false;
const MAX_RETRIES = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectDB(attempt = 0) {
  try {
    if (!process.env.MONGO_URI) throw new Error("MONGO_URI no definida en las variables de entorno");

    // Cerrar instancia anterior si existe
    if (mongoInstance) {
      try { await mongoInstance.close(); } catch {}
    }

    mongoInstance = new MongoClient(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
    });

    console.log(`⏳ Conectando a MongoDB (intento ${attempt + 1}/${MAX_RETRIES})...`);
    await mongoInstance.connect();

    db          = mongoInstance.db("discordBot");
    isConnected = true;
    console.log("🔥 MongoDB conectado correctamente");

    // Índices para optimizar consultas
    await Promise.all([
      db.collection("activityLogs").createIndex({ createdAt: 1 }),
      db.collection("activityLogs").createIndex({ userId: 1, weekStart: 1 }),
      db.collection("weeklyLeaderboards").createIndex({ weekStart: -1 }, { unique: true }),
    ]);

    // Reconexión automática si se cae la conexión
    mongoInstance.on("close", async () => {
      isConnected = false;
      console.warn("⚠️  MongoDB desconectado. Reintentando en 3s...");
      await sleep(3000);
      connectDB(); // reinicia desde intento 0
    });

  } catch (err) {
    isConnected = false;
    console.error(`❌ MongoDB error (intento ${attempt + 1}/${MAX_RETRIES}):`, err.message);

    if (attempt < MAX_RETRIES - 1) {
      // Backoff exponencial: 2s → 4s → 8s → 16s → 32s
      const delay = 2000 * Math.pow(2, attempt);
      console.log(`🔄 Reintentando en ${delay / 1000}s...`);
      await sleep(delay);
      return connectDB(attempt + 1);
    }

    console.error("❌ No se pudo conectar a MongoDB tras múltiples intentos. El bot sigue activo sin DB.");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN — Railway envía SIGTERM al reiniciar/detener el servicio
// ─────────────────────────────────────────────────────────────────────────────
async function gracefulShutdown(signal) {
  console.log(`\n[Shutdown] Señal ${signal} recibida — cerrando limpiamente...`);

  // Intentar loguear antes de destruir el cliente
  try {
    const logCh = client.channels.cache.get(LOG_CHANNEL_ID);
    if (logCh) {
      await logCh.send({
        embeds: [
          new EmbedBuilder()
            .setColor("#e74c3c")
            .setTitle("🔴 Bot apagado")
            .setDescription(`Señal \`${signal}\` recibida. Cerrando limpiamente.`)
            .setTimestamp(),
        ],
      });
    }
  } catch {}

  try { client.destroy();                              console.log("✅ Discord desconectado"); } catch {}
  try { if (mongoInstance) await mongoInstance.close(); console.log("✅ MongoDB cerrado");     } catch {}

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS DE FECHA
// Colombia = UTC-5 constante (no tiene horario de verano)
// Semana: Domingo 00:00 UTC ≡ Sábado 19:00 COL (inicio) → Domingo 00:00 UTC siguiente
// ─────────────────────────────────────────────────────────────────────────────
const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function getISOWeek(date) {
  const d   = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = d.getUTCDay() || 7; // Lun=1 … Dom=7
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const y1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - y1) / 86400000 + 1) / 7);
}

function formatDateES(date) {
  return `${date.getUTCDate()} de ${MESES[date.getUTCMonth()]}`;
}

// Devuelve { start, end } del período semanal actual (en UTC)
function getWeekRange() {
  const now   = new Date();
  const start = new Date(now);
  start.setUTCDate(now.getUTCDate() - now.getUTCDay()); // retrocede al domingo
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);

  return { start, end };
}

// displayStart = Sábado (start − 1 día), para mostrar "Del sáb X al sáb Y"
function getDisplayDates(weekStart, weekEnd) {
  const DAY = 24 * 60 * 60 * 1000;
  return {
    displayStart: new Date(weekStart.getTime() - DAY),
    displayEnd:   new Date(weekEnd.getTime()   - DAY),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DB HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Guarda una completación en MongoDB
async function registrarCompletacion(user, activityName) {
  if (!db) return console.error("❌ DB no disponible — no se guardó la completación");
  const { start: weekStart } = getWeekRange();
  await db.collection("activityLogs").insertOne({
    userId:       user.id,
    username:     user.tag,
    activityName,
    weekStart,          // para queries por semana eficientes
    createdAt:    new Date(),
  });
}

// Top 10 del período indicado (si no se pasan fechas, usa la semana actual)
async function getWeeklyTop(start, end) {
  if (!db) return [];
  if (!start || !end) ({ start, end } = getWeekRange());

  return await db.collection("activityLogs").aggregate([
    { $match: { createdAt: { $gte: start, $lt: end } } },
    { $group: { _id: "$userId", count: { $sum: 1 }, username: { $last: "$username" } } },
    { $sort: { count: -1 } },
    { $limit: 10 },
  ]).toArray();
}

// Guarda el top semanal en la colección de historial (upsert para evitar duplicados)
async function guardarTopSemanal(top, weekStart, weekEnd) {
  if (!db) return;
  const { displayStart, displayEnd } = getDisplayDates(weekStart, weekEnd);

  await db.collection("weeklyLeaderboards").updateOne(
    { weekStart },
    {
      $set: {
        weekEnd,
        displayStart,
        displayEnd,
        weekNumber: getISOWeek(displayStart),
        year:       displayStart.getUTCFullYear(),
        top: top.map((u) => ({ userId: u._id, username: u.username, count: u.count })),
        savedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

// Últimas N semanas guardadas (para el historial)
async function getHistorialSemanas(limit = 24) {
  if (!db) return [];
  return await db.collection("weeklyLeaderboards")
    .find({})
    .sort({ weekStart: -1 })
    .limit(limit)
    .toArray();
}

// Estadísticas personales de un usuario
async function getMisActividades(userId) {
  if (!db) return null;

  const WEEK_MS             = 7 * 24 * 60 * 60 * 1000;
  const { start: weekStart } = getWeekRange();
  const col                  = db.collection("activityLogs");

  // Todas las queries en paralelo para mayor velocidad
  const [thisWeek, allTime, bestWeekArr, weekPart] = await Promise.all([
    // Esta semana
    col.countDocuments({ userId, weekStart }),

    // Total histórico
    col.countDocuments({ userId }),

    // Mejor semana (excluye registros sin weekStart de versiones anteriores del bot)
    col.aggregate([
      { $match: { userId, weekStart: { $exists: true, $ne: null } } },
      { $group: { _id: "$weekStart", count: { $sum: 1 } } },
      { $sort:  { count: -1 } },
      { $limit: 1 },
    ]).toArray(),

    // Semanas en que participó (para calcular racha)
    col.aggregate([
      { $match: { userId, weekStart: { $exists: true, $ne: null } } },
      { $group: { _id: "$weekStart" } },
      { $sort:  { _id: -1 } },
    ]).toArray(),
  ]);

  const bestWeek = bestWeekArr.length > 0 ? bestWeekArr[0].count : 0;

  // Racha: semanas consecutivas desde la más reciente hacia atrás
  let streak = 0;
  if (weekPart.length > 0) {
    const mostRecent = weekPart[0]._id;
    for (let i = 0; i < weekPart.length; i++) {
      const expected = new Date(mostRecent.getTime() - i * WEEK_MS);
      if (weekPart[i]._id.getTime() === expected.getTime()) streak++;
      else break;
    }
  }

  return { thisWeek, allTime, bestWeek, streak };
}

// ─────────────────────────────────────────────────────────────────────────────
// DISCORD HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Envía un embed al canal de logs
async function sendLog(title, description, color = "#3498db") {
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID);
    await ch.send({
      embeds: [
        new EmbedBuilder()
          .setColor(color)
          .setTitle(title)
          .setDescription(description)
          .setTimestamp(),
      ],
    });
  } catch (err) {
    console.error("[Log] No se pudo enviar al canal de logs:", err.message);
  }
}

// Construye el embed del leaderboard (reutilizable para historial y automático)
function buildLeaderboardEmbed(top, weekStart, weekEnd, isPreview) {
  const medals               = ["🥇", "🥈", "🥉"];
  const { displayStart, displayEnd } = getDisplayDates(weekStart, weekEnd);
  const weekNum              = getISOWeek(displayStart);

  const description =
    top.length === 0
      ? "😔 Nadie participó esta semana.\n¡Participa la próxima!"
      : top
          .map((u, i) => {
            const userId = u._id ?? u.userId;
            const prefix = medals[i] ?? `**${i + 1}.**`;
            return `${prefix} <@${userId}> — **${u.count}** actividad${u.count !== 1 ? "es" : ""}`;
          })
          .join("\n");

  return new EmbedBuilder()
    .setColor("#f1c40f")
    .setTitle(`🏆 Top Semanal — Semana ${weekNum}`)
    .setDescription(description)
    .addFields({
      name:  "📅 Período",
      value: `Del **${formatDateES(displayStart)}** al **${formatDateES(displayEnd)}**`,
    })
    .setTimestamp()
    .setFooter({ text: isPreview ? "🔍 Vista previa — el conteo sigue corriendo" : "✅ Semana cerrada" });
}

// Construye el StringSelectMenu del historial marcando la semana activa
function buildWeekSelectMenu(semanas, selectedValue) {
  const { start: cs, end: ce }           = getWeekRange();
  const { displayStart: cds, displayEnd: cde } = getDisplayDates(cs, ce);
  const cWeekNum                         = getISOWeek(cds);

  const currentLabel = `Semana ${cWeekNum} | Del ${formatDateES(cds)} - ${formatDateES(cde)} ← Actual`;

  const options = [
    new StringSelectMenuOptionBuilder()
      .setLabel(currentLabel.slice(0, 100))
      .setValue("current")
      .setDefault(selectedValue === "current"),
  ];

  for (const sem of semanas) {
    const ds  = new Date(sem.displayStart);
    const de  = new Date(sem.displayEnd);
    const lbl = `Semana ${sem.weekNumber} | Del ${formatDateES(ds)} - ${formatDateES(de)}`;
    const val = new Date(sem.weekStart).getTime().toString();

    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel(lbl.slice(0, 100))
        .setValue(val)
        .setDefault(selectedValue === val)
    );
  }

  return new StringSelectMenuBuilder()
    .setCustomId("leaderboard_week_select")
    .setPlaceholder("📅 Selecciona una semana...")
    .addOptions(options.slice(0, 25)); // Discord permite máximo 25 opciones
}

// Set para evitar race conditions en el botón de completar
const processingMessages = new Set();

// ─────────────────────────────────────────────────────────────────────────────
// READY
// ─────────────────────────────────────────────────────────────────────────────
client.once("clientReady", async () => {
  console.log(`✅ ${client.user.tag} listo`);
  await connectDB();
  if (!isConnected) console.warn("⚠️  Bot activo SIN base de datos");
  await sendLog("🟢 Bot iniciado", `\`${client.user.tag}\` está online y listo.`, "#2ecc71");
  setInterval(checkActivities, 60 * 1000);
});

// ─────────────────────────────────────────────────────────────────────────────
// INTERACCIONES
// ─────────────────────────────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {

  // ── Slash Commands ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {

    // ── /testactivity ─────────────────────────────────────────────────────────
    if (interaction.commandName === "testactivity") {
      const activity = activities[Math.floor(Math.random() * activities.length)];
      await sendActivityEmbed(interaction, activity, true);
    }

    // ── /topleaderboard — solo usuarios con ROLE_ID ───────────────────────────
    if (interaction.commandName === "topleaderboard") {
      if (!interaction.inGuild()) return;

      if (!interaction.member.roles.cache.has(ROLE_ID)) {
        return interaction.reply({
          content: "❌ No tienes permiso para usar este comando.",
          flags:   MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await enviarLeaderboard(interaction.channel, true);
      await interaction.editReply({ content: "✅ Top semanal enviado." });
    }

    // ── /misactividades — estadísticas personales ─────────────────────────────
    if (interaction.commandName === "misactividades") {
      if (!interaction.inGuild()) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const stats = await getMisActividades(interaction.user.id);

      if (!stats) {
        return interaction.editReply({
          content: "❌ Base de datos no disponible en este momento. Intenta más tarde.",
        });
      }

      const embed = new EmbedBuilder()
        .setColor("#3498db")
        .setTitle(`📊 Mis actividades — ${interaction.user.username}`)
        .setThumbnail(interaction.user.displayAvatarURL())
        .addFields(
          {
            name:   "📅 Esta semana",
            value:  `**${stats.thisWeek}** actividad${stats.thisWeek !== 1 ? "es" : ""}`,
            inline: true,
          },
          {
            name:   "🏆 Total histórico",
            value:  `**${stats.allTime}** actividad${stats.allTime !== 1 ? "es" : ""}`,
            inline: true,
          },
          {
            name:   "⭐ Mejor semana",
            value:  `**${stats.bestWeek}** actividad${stats.bestWeek !== 1 ? "es" : ""}`,
            inline: true,
          },
          {
            name:   "🔥 Racha actual",
            value:  stats.streak > 0
              ? `**${stats.streak}** semana${stats.streak !== 1 ? "s" : ""} consecutiva${stats.streak !== 1 ? "s" : ""}`
              : "Sin racha activa",
            inline: true,
          }
        )
        .setTimestamp()
        .setFooter({ text: "Sistema de actividades" });

      await interaction.editReply({ embeds: [embed] });
    }

    // ── /resetleaderboard — solo OWNER_ID ─────────────────────────────────────
    if (interaction.commandName === "resetleaderboard") {
      if (!interaction.inGuild()) return;

      if (interaction.user.id !== OWNER_ID) {
        return interaction.reply({
          content: "❌ No tienes permiso para usar este comando.",
          flags:   MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (!db) {
        return interaction.editReply({ content: "❌ Base de datos no disponible." });
      }

      const { start, end } = getWeekRange();
      const result = await db.collection("activityLogs").deleteMany({
        createdAt: { $gte: start, $lt: end },
      });

      await sendLog(
        "⚠️ Reset de leaderboard semanal",
        `${interaction.user} (\`${interaction.user.tag}\`) eliminó **${result.deletedCount}** registro${result.deletedCount !== 1 ? "s" : ""} de la semana actual.`,
        "#e74c3c"
      );

      await interaction.editReply({
        content: `✅ Se eliminaron **${result.deletedCount}** registro${result.deletedCount !== 1 ? "s" : ""} de esta semana.`,
      });
    }

    // ── /historialleaderboard — navegar semanas anteriores ────────────────────
    if (interaction.commandName === "historialleaderboard") {
      if (!interaction.inGuild()) return;
      await interaction.deferReply();

      const semanas    = await getHistorialSemanas(24);
      const { start, end } = getWeekRange();
      const currentTop = await getWeeklyTop(start, end);

      const embed      = buildLeaderboardEmbed(currentTop, start, end, true);
      const selectMenu = buildWeekSelectMenu(semanas, "current");
      const row        = new ActionRowBuilder().addComponents(selectMenu);

      await interaction.editReply({ embeds: [embed], components: [row] });
    }
  }

  // ── Select Menu: navegar historial ──────────────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId === "leaderboard_week_select") {
    await interaction.deferUpdate();

    const value   = interaction.values[0];
    const semanas = await getHistorialSemanas(24);
    let   embed;

    if (value === "current") {
      const { start, end } = getWeekRange();
      const top = await getWeeklyTop(start, end);
      embed = buildLeaderboardEmbed(top, start, end, true);
    } else {
      const targetMs = parseInt(value);
      const record   = semanas.find((s) => new Date(s.weekStart).getTime() === targetMs);

      if (!record) {
        return interaction.followUp({
          content: "❌ Semana no encontrada en el historial.",
          flags:   MessageFlags.Ephemeral,
        });
      }

      // Normaliza el formato para reutilizar buildLeaderboardEmbed
      const top = record.top.map((u) => ({
        _id:      u.userId,
        username: u.username,
        count:    u.count,
      }));
      embed = buildLeaderboardEmbed(
        top,
        new Date(record.weekStart),
        new Date(record.weekEnd),
        false
      );
    }

    // Reconstruye el select menu marcando la opción seleccionada como default
    const selectMenu = buildWeekSelectMenu(semanas, value);
    const row        = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.editReply({ embeds: [embed], components: [row] });
  }

  // ── Botón: completar actividad ──────────────────────────────────────────────
  if (interaction.isButton()) {
    await interaction.deferUpdate();

    const msgId = interaction.message.id;

    // ── Protección anti race-condition ──
    // Node.js es sing