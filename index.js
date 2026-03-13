const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  REST,
  Routes,
} = require("discord.js");

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const activities = require("./activities.json");

const CHANNEL_ID = "1464711416610029781";
const ROLE_ID = "1464711553625489638";

/* ================= READY ================= */
client.once("clientReady", () => {
  console.log(`${client.user.tag} ha iniciado`);
  setInterval(checkActivities, 60 * 1000);
});

/* ================= INTERACTIONS ================= */
client.on("interactionCreate", async (interaction) => {
  /* SLASH COMMAND */
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "testactivity") {
      const activity = activities[0]; // actividad de prueba
      await sendActivityEmbed(interaction, activity, true);
    }
  }

  /* BUTTON */
  if (interaction.isButton()) {
    await interaction.deferUpdate();

    try {
      const oldEmbed = interaction.message.embeds[0];

      if (!oldEmbed) return;

      const completedEmbed = EmbedBuilder.from(oldEmbed)
        .setColor("#2ecc71")
        .setDescription(
          `✅ **Actividad de ${oldEmbed.title} ha sido completada por ${interaction.user}**`,
        );

      await interaction.message.edit({
        embeds: [completedEmbed],
        components: [],
      });
    } catch (err) {
      if (err.code === 10008) {
        return interaction.followUp({
          content: "⚠️ Esta actividad ya no es válida (el bot fue reiniciado).",
          ephemeral: true,
        });
      }
      console.error(err);
    }
  }
});

/* ================= CHECK ACTIVITIES ================= */
async function checkActivities() {
  const now = new Date();

  // Hora UTC
  let hours = now.getUTCHours() - 5; // GMT-5
  const minutes = now.getUTCMinutes();

  // Ajuste si queda negativa
  if (hours < 0) hours += 24;

  for (const activity of activities) {
    const [hour, minute] = activity.time.split(":").map(Number);

    if (hours === hour && minutes === minute) {
      await sendActivityEmbed(null, activity, false);
    }
  }
}

/* ================= SEND EMBED ================= */
async function sendActivityEmbed(interaction, activity, isTest) {
const embed = new EmbedBuilder()
  .setColor("#0099ff")
  .setTitle(`🚨 ${activity.name}`)
  .setDescription(`📢 **${activity.description}**`)
  .addFields({
    name: "🕒 Horario",
    value: `**${activity.time}**`,
    inline: true
  })
  .setImage(activity.image)
  .setTimestamp()
  .setFooter({
    text: "Sistema de actividades"
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`complete_${activity.name}`)
      .setLabel("Marcar como completada")
      .setStyle(ButtonStyle.Success),
  );

  if (isTest) {
    await interaction.reply({
      content: "🧪 **Actividad enviada en modo prueba**",
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

/* ================= SLASH COMMAND REGISTER ================= */
const commands = [
  {
    name: "testactivity",
    description: "Simula una actividad en curso",
  },
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: commands,
    });
    console.log("Comando slash registrado");
  } catch (err) {
    console.error(err);
  }
})();

client.on("error", console.error);
process.on("unhandledRejection", console.error);

client.login(process.env.DISCORD_TOKEN);
