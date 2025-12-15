// commands/testactivity.js
const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("testactivity")
    .setDescription("Simula el envío de una actividad en curso"),

  async execute(interaction) {
    await interaction.reply({ content: "Simulando actividad..." });
    // Aquí puedes llamar a sendActivityEmbed para simular
  },
};
