// ---------------- IMPORTS ----------------
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events } = require('discord.js');
const mongoose = require('mongoose');
require('dotenv').config();
const express = require('express');

// ---------------- MONGODB ----------------
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log("🟢 Conectado a MongoDB Atlas"))
.catch(err => console.error("🔴 Error conectando a MongoDB:", err));

// ---------------- ESQUEMA ----------------
const infractionSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    count: { type: Number, default: 0 },
    lastInfraction: { type: Date, default: Date.now },
    timeouts: { type: Number, default: 0 }
});
const Infraction = mongoose.model('Infraction', infractionSchema);

// ---------------- KEEP ALIVE ----------------
const app = express();
app.get('/', (req, res) => res.send('Bot activo'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Servidor web activo en puerto ${PORT}`));

// ---------------- CLIENT ----------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// ---------------- CONFIGURACIÓN ----------------
const PERMISSION_RESET_TIME = 30 * 1000; // 30s
const MAX_INFRACTIONS = 3;
const TIMEOUT_DURATION = 4 * 60 * 60 * 1000; // 4h
const MAX_TIMEOUTS = 3;
const INFRACTION_DECAY_TIME = 20 * 24 * 60 * 60 * 1000; // 20 días

const blockedUsers = new Map();
const MOD_CHANNEL_ID = process.env.MOD_CHANNEL_ID; // Canal donde se envían alertas

// ---------------- CLIENT READY ----------------
client.once('clientReady', () => {
    console.log(`✅ Bot coordinador activo como ${client.user.tag}`);
});

// ---------------- FUNCIONES ----------------
async function applyInfractionDecay(userData) {
    const now = Date.now();
    const timePassed = now - userData.lastInfraction.getTime();
    const decaySteps = Math.floor(timePassed / INFRACTION_DECAY_TIME);

    if (decaySteps > 0) {
        userData.count = Math.max(0, userData.count - decaySteps);
        userData.lastInfraction = new Date(userData.lastInfraction.getTime() + decaySteps * INFRACTION_DECAY_TIME);

        if (userData.count === 0 && userData.timeouts === 0) {
            await Infraction.deleteOne({ userId: userData.userId });
            return null;
        } else {
            await userData.save();
        }
    }
    return userData;
}

async function applyInfraction(member, reason) {
    let userData = await Infraction.findOne({ userId: member.id });
    if (userData) userData = await applyInfractionDecay(userData);
    if (!userData) userData = new Infraction({ userId: member.id });

    userData.count++;
    userData.lastInfraction = new Date();
    await userData.save();

    try {
        await member.send(
            `❌ Has recibido una infracción: ${reason}\n` +
            `⚠️ Infracciones actuales: ${userData.count}/${MAX_INFRACTIONS}`
        );
    } catch {}

    if (userData.count >= MAX_INFRACTIONS) {
        userData.timeouts++;
        userData.count = 0;
        await userData.save();

        try {
            await member.timeout(TIMEOUT_DURATION, 'Exceder límite de actividades prohibidas');
            await member.send(`⏱ Has recibido un timeout de 4 horas por exceder el límite de infracciones.`);
        } catch {}

        if (userData.timeouts >= MAX_TIMEOUTS) {
            try {
                await member.ban({ reason: 'Exceder límite de timeouts por actividades prohibidas' });
            } catch {}
        }
    }
}

// ---------------- DETECCIÓN DE STREAMING ----------------
client.on('voiceStateUpdate', async (oldState, newState) => {
    const member = newState.member;
    if (!member || member.user.bot) return;

    // Si empieza a compartir pantalla
    if (newState.streaming && !oldState.streaming) {
        const modChannel = await client.channels.fetch(MOD_CHANNEL_ID);
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
            content: `⚠️ Usuario: ${member} compartió pantalla en ${newState.channel}`,
            components: [row]
        });
    }
});

// ---------------- BOTONES ----------------
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    const [accion, userId] = interaction.customId.split('-');
    const member = await interaction.guild.members.fetch(userId);

    if (accion === 'sumar') {
        await applyInfraction(member, 'Contenido inapropiado detectado por moderación');
        await interaction.reply({ content: `✅ Infracción aplicada a ${member}`, ephemeral: true });
    } else if (accion === 'permitido') {
        await interaction.reply({ content: `✅ Marcado como permitido`, ephemeral: true });
    }
});

// ---------------- LOGIN ----------------
client.login(process.env.DISCORD_TOKEN);