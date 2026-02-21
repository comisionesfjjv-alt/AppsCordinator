// ---------------- IMPORTS ----------------
const { Client, GatewayIntentBits } = require('discord.js');
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
const allowedActivities = [
    'Lofi',
    'Whiteboard',
    'TuneIn Radio & Podcasts'
];

const PERMISSION_RESET_TIME = 30 * 1000; // 30s
const MAX_INFRACTIONS = 3;
const TIMEOUT_DURATION = 4 * 60 * 60 * 1000; // 4h
const MAX_TIMEOUTS = 3;
const INFRACTION_DECAY_TIME = 20 * 24 * 60 * 60 * 1000; // 20 días

const blockedUsers = new Map();

// ---------------- CLIENT READY ----------------
client.once('ready', () => {
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

        // Si no hay infracciones ni timeouts, borramos el registro
        if (userData.count === 0 && userData.timeouts === 0) {
            await Infraction.deleteOne({ userId: userData.userId });
            return null;
        } else {
            await userData.save();
        }
    }

    return userData;
}

async function handleActivity(member, name, channel) {
    if (allowedActivities.includes(name)) return;
    if (blockedUsers.has(member.id)) return;

    // Buscar o crear usuario en Mongo
    let userData = await Infraction.findOne({ userId: member.id });
    if (userData) userData = await applyInfractionDecay(userData);

    if (!userData) {
        userData = new Infraction({ userId: member.id });
    }

    // Aumentamos infracciones
    userData.count++;
    userData.lastInfraction = new Date();
    await userData.save();

    try {
        await member.send(
            `❌ La actividad "${name}" no está permitida.\n` +
            `✅ Actividades permitidas: ${allowedActivities.join(', ')}\n` +
            `⚠️ Infracciones actuales: ${userData.count}/${MAX_INFRACTIONS}`
        );
    } catch {}

    // Timeout y ban
    if (userData.count >= MAX_INFRACTIONS) {
        userData.timeouts++;
        userData.count = 0;
        await userData.save();

        try {
            await member.timeout(TIMEOUT_DURATION, 'Exceder límite de actividades prohibidas');
            await member.send(`⏱ Has recibido un timeout de 4 horas por iniciar actividades no permitidas.`);
        } catch {}

        if (userData.timeouts >= MAX_TIMEOUTS) {
            try {
                await member.ban({ reason: 'Exceder límite de timeouts por actividades prohibidas' });
            } catch {}
        }
    }

    blockedUsers.set(member.id, true);

    try {
        await channel.permissionOverwrites.edit(member, { UseApplicationCommands: false });
    } catch {}

    setTimeout(async () => {
        try { await channel.permissionOverwrites.delete(member.id); } catch {}
        blockedUsers.delete(member.id);
    }, PERMISSION_RESET_TIME);
}

// ---------------- EVENTO ----------------
client.on('voiceStateUpdate', async (oldState, newState) => {
    const member = newState.member;
    if (!member || member.user.bot) return;

    const oldActivities = oldState?.activities?.map(a => a.name) || [];
    const newActivities = newState?.activities?.map(a => a.name) || [];

    for (const name of newActivities) {
        if (!oldActivities.includes(name)) {
            await handleActivity(member, name, newState.channel);
        }
    }
});

// ---------------- LOGIN ----------------
client.login(process.env.DISCORD_TOKEN);

// ---------------- PRUEBAS ----------------
client.on('voiceStateUpdate', async (oldState, newState) => {
    const member = newState.member;
    if (!member || member.user.bot) return;

    const oldActivities = oldState?.activities?.map(a => a.name) || [];
    const newActivities = newState?.activities?.map(a => a.name) || [];

    for (const name of newActivities) {
        if (!oldActivities.includes(name)) {
            console.log(`[Actividad detectada] Usuario: ${member.user.tag}, Actividad: ${name}`);
            await handleActivity(member, name, newState.channel);
        }
    }
});