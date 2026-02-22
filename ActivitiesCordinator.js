// ---------------- IMPORTS ----------------
const {
    Client,
    GatewayIntentBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    InteractionType
} = require('discord.js');

const mongoose = require('mongoose');
require('dotenv').config();
const express = require('express');

// ---------------- EXPRESS KEEP ALIVE ----------------
const app = express();

app.get('/', (req, res) => res.send('Bot activo'));
app.get('/health', (req, res) => res.status(200).send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web server activo en puerto ${PORT}`));

// ---------------- MONGODB ----------------
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("🟢 Conectado a MongoDB Atlas"))
.catch(err => console.error("🔴 Error MongoDB:", err));

// ---------------- ESQUEMA ----------------
const infractionSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    count: { type: Number, default: 0 },
    lastInfraction: { type: Date, default: Date.now },
    timeouts: { type: Number, default: 0 }
});

const Infraction = mongoose.model('Infraction', infractionSchema);

// ---------------- CLIENT ----------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ],
    restTimeOffset: 0,
    failIfNotExists: false
});

// ---------------- CONFIG ----------------
const MAX_INFRACTIONS = 3;
const TIMEOUT_DURATION = 4 * 60 * 60 * 1000;
const MAX_TIMEOUTS = 3;
const INFRACTION_DECAY_TIME = 20 * 24 * 60 * 60 * 1000;
const MOD_CHANNEL_ID = process.env.MOD_CHANNEL_ID;

// ---------------- LOGS DE ESTABILIDAD ----------------
client.on('ready', () => {
    console.log(`✅ Bot conectado como ${client.user.tag}`);
});

client.on('disconnect', () => {
    console.log("⚠️ Bot desconectado.");
});

client.on('reconnecting', () => {
    console.log("🔄 Intentando reconectar...");
});

client.on('error', (error) => {
    console.error("❌ Error del cliente:", error);
});

process.on('unhandledRejection', error => {
    console.error("🚨 Promesa no manejada:", error);
});

process.on('uncaughtException', error => {
    console.error("🚨 Excepción no capturada:", error);
});

// ---------------- DECAY ----------------
async function applyInfractionDecay(userData) {
    const now = Date.now();
    const timePassed = now - userData.lastInfraction.getTime();
    const decaySteps = Math.floor(timePassed / INFRACTION_DECAY_TIME);

    if (decaySteps > 0) {
        userData.count = Math.max(0, userData.count - decaySteps);
        userData.lastInfraction = new Date(
            userData.lastInfraction.getTime() + decaySteps * INFRACTION_DECAY_TIME
        );

        if (userData.count === 0 && userData.timeouts === 0) {
            await Infraction.deleteOne({ userId: userData.userId });
            return null;
        } else {
            await userData.save();
        }
    }

    return userData;
}

// ---------------- APLICAR INFRACCIÓN ----------------
async function applyInfraction(member, reason, channel) {

    let userData = await Infraction.findOne({ userId: member.id });
    if (userData) userData = await applyInfractionDecay(userData);
    if (!userData) userData = new Infraction({ userId: member.id });

    userData.count++;
    userData.lastInfraction = new Date();
    await userData.save();

    try {
        await member.send(
            `❌ Infracción: ${reason}\n` +
            `⚠️ ${userData.count}/${MAX_INFRACTIONS} infracciones\n` +
            `⏱ ${userData.timeouts}/${MAX_TIMEOUTS} timeouts`
        );
    } catch {}

    if (channel) {
        await channel.send(`⚠️ Infracción aplicada a ${member}: "${reason}"`);
    }

    if (userData.count >= MAX_INFRACTIONS) {

        userData.timeouts++;
        userData.count = 0;
        await userData.save();

        try {
            await member.timeout(TIMEOUT_DURATION, 'Límite de infracciones');
            await member.send(`⏱ Timeout de 4 horas aplicado.`);
        } catch {}

        if (userData.timeouts >= MAX_TIMEOUTS) {
            try {
                await member.ban({ reason: 'Exceso de timeouts' });
            } catch {}
        }
    }
}

// ---------------- STREAM DETECTION ----------------
client.on('voiceStateUpdate', async (oldState, newState) => {

    const member = newState.member;
    if (!member || member.user.bot) return;

    if (newState.streaming && !oldState.streaming) {

        const modChannel = await client.channels.fetch(MOD_CHANNEL_ID).catch(() => null);
        if (!modChannel) return;

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`sumar-${member.id}`)
                .setLabel('Sumar infracción')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`permitido-${member.id}`)
                .setLabel('Permitido')
                .setStyle(ButtonStyle.Success)
        );

        await modChannel.send({
            content: `⚠️ ${member} compartió pantalla en ${newState.channel}`,
            components: [row]
        });
    }
});

// ---------------- INTERACCIONES ----------------
client.on('interactionCreate', async interaction => {

    if (interaction.isButton()) {

        const [accion, userId] = interaction.customId.split('-');
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (!member) return;

        await interaction.update({ components: [] });

        // Si el moderador decide sumar una infracción, se le pide una justificación mediante un modal.
        if (accion === 'sumar') {

            const modal = new ModalBuilder()
                .setCustomId(`modal-${userId}`)
                .setTitle('Justificación')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('justificacion')
                            .setLabel('Motivo')
                            .setStyle(TextInputStyle.Paragraph)
                            .setRequired(true)
                    )
                );

            await interaction.showModal(modal);

        } else if (accion === 'permitido') {

            await interaction.followUp({
                content: `✅ Permitido: ${member.user.tag}`,
                ephemeral: true
            });
        }
    }

    if (interaction.type === InteractionType.ModalSubmit) {

        const userId = interaction.customId.split('-')[1];
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (!member) return;

        const justification = interaction.fields.getTextInputValue('justificacion');

        await applyInfraction(member, justification, interaction.channel);

        await interaction.reply({
            content: `✅ Infracción aplicada.`,
            ephemeral: true
        });
    }
});

// ---------------- LOGIN ----------------
client.login(process.env.DISCORD_TOKEN);