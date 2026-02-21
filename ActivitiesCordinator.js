const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const mongoose = require('mongoose');
require('dotenv').config();

// ---------------- keepAlive ----------------
const express = require('express');
const app = express();

app.get('/', (req, res) => {
    res.send('Bot activo');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Servidor web activo en puerto ${PORT}`);
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// ---------------- Configuración ----------------
const allowedActivities = [
    'Lofi',
    'Whiteboard',
    'TuneIn Radio & Podcasts'
];

const PERMISSION_RESET_TIME = 30 * 1000; // 30 segundos para resetear permisos después de bloquear al usuario
const MAX_INFRACTIONS = 3; // Número de infracciones antes de aplicar timeout
const TIMEOUT_DURATION = 4 * 60 * 60 * 1000; // 4 horas de timeout
const MAX_TIMEOUTS = 3; // Número de timeouts antes de banear al usuario

const INFRACTION_DECAY_TIME = 20 * 24 * 60 * 60 * 1000; // 20 días

// ---------------- Archivo de datos ----------------
const DATA_FILE = './activityData.json';
let data = { infractions: {}, timeouts: {} };

if (fs.existsSync(DATA_FILE)) {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

// Guardar datos en el archivo
function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const blockedUsers = new Map(); // Map para rastrear usuarios bloqueados temporalmente

// ---------------- Inicialización ----------------
client.once('ready', () => {
    console.log(`✅ Bot coordinador activo como ${client.user.tag}`);
});

// ---------------- Función para aplicar decay ----------------
function applyInfractionDecay(userId) {
    const userData = data.infractions[userId];
    if (!userData) return;

    const now = Date.now();
    const timePassed = now - userData.lastInfraction;

    // Calculamos cuántos periodos de decay han pasado desde la última infracción
    const decaySteps = Math.floor(timePassed / INFRACTION_DECAY_TIME);

    if (decaySteps > 0) {
        userData.count = Math.max(0, userData.count - decaySteps);

        // Ajustamos la fecha hacia adelante según lo descontado
        userData.lastInfraction += decaySteps * INFRACTION_DECAY_TIME;

        if (userData.count === 0) {
            delete data.infractions[userId];
        }

        saveData();
    }
}

// ---------------- Control principal ----------------
async function handleActivity(member, name, channel) {

    if (allowedActivities.includes(name)) return;
    if (blockedUsers.has(member.id)) return;

    applyInfractionDecay(member.id);

    let userData = data.infractions[member.id];

    if (!userData) {
        userData = { count: 0, lastInfraction: Date.now() };
    }

    userData.count++;
    userData.lastInfraction = Date.now();

    data.infractions[member.id] = userData;
    saveData();

    try {
        await member.send(
            `❌ La actividad "${name}" no está permitida.\n` +
            `✅ Actividades permitidas: ${allowedActivities.join(', ')}\n` +
            `⚠️ Infracciones actuales: ${userData.count}/${MAX_INFRACTIONS}`
        );
    } catch {}

    // Si el usuario excede el límite de infracciones, aplicar timeout y potencialmente ban
    if (userData.count >= MAX_INFRACTIONS) {

        let countTimeouts = data.timeouts[member.id] || 0;
        countTimeouts++;
        data.timeouts[member.id] = countTimeouts;

        delete data.infractions[member.id];
        saveData();

        try {
            await member.timeout(TIMEOUT_DURATION, 'Exceder límite de actividades prohibidas');
            await member.send(`⏱ Has recibido un timeout de 4 horas por iniciar actividades no permitidas.`);
        } catch {}

        if (countTimeouts >= MAX_TIMEOUTS) {
            try {
                await member.ban({ reason: 'Exceder límite de timeouts por actividades prohibidas' });
            } catch {}
        }
    }

    blockedUsers.set(member.id, true);

    try {
        await channel.permissionOverwrites.edit(member, {
            UseApplicationCommands: false
        });
    } catch {}

    setTimeout(async () => {
        try {
            await channel.permissionOverwrites.delete(member.id);
        } catch {}
        blockedUsers.delete(member.id);
    }, PERMISSION_RESET_TIME);
}

// ---------------- Evento principal ----------------
client.on('voiceStateUpdate', async (oldState, newState) => {
    const member = newState.member;
    if (!member) return;
    if (member.user.bot) return;

    const oldActivities = oldState?.activities?.map(a => a.name) || [];
    const newActivities = newState?.activities?.map(a => a.name) || [];

    newActivities.forEach(async (name) => {
        if (!oldActivities.includes(name)) {
            await handleActivity(member, name, newState.channel);
        }
    });
});

client.login(process.env.DISCORD_TOKEN);