const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');

// ===================== CONFIGURAÇÕES =====================
const GUILD_ID = '123456789012345678';  // COLOQUE O ID DO SEU SERVIDOR AQUI
const CATEGORY_NAME = '🎫 TICKETS';      // Nome da categoria (será criada automaticamente)
const LOG_CHANNEL_ID = '0';              // Coloque o ID do canal de logs ou deixe 0

// ===================== BANCO DE DADOS =====================
let db;

async function initDatabase() {
    db = await open({
        filename: './tickets.db',
        driver: sqlite3.Database
    });
    
    await db.exec(`
        CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        
        CREATE TABLE IF NOT EXISTS category_roles (
            category TEXT PRIMARY KEY,
            role_id TEXT
        );
        
        CREATE TABLE IF NOT EXISTS staff_roles (
            role_id TEXT PRIMARY KEY
        );
        
        CREATE TABLE IF NOT EXISTS active_tickets (
            channel_id TEXT PRIMARY KEY,
            user_id TEXT,
            category TEXT,
            staff_id TEXT,
            created_at TEXT
        );
    `);
    
    console.log('✅ Banco de dados inicializado');
}

// ===================== CLIENT =====================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

let ticketCategoryId = null;

// ===================== FUNÇÕES AUXILIARES =====================
async function getOrCreateCategory(guild) {
    if (ticketCategoryId) {
        const category = guild.channels.cache.get(ticketCategoryId);
        if (category) return category;
    }
    
    let category = guild.channels.cache.find(c => c.name === CATEGORY_NAME && c.type === 4);
    if (!category) {
        category = await guild.channels.create({
            name: CATEGORY_NAME,
            type: 4,
            permissionOverwrites: [
                {
                    id: guild.id,
                    deny: [PermissionFlagsBits.ViewChannel]
                }
            ]
        });
        console.log(`✅ Categoria "${CATEGORY_NAME}" criada!`);
    }
    
    ticketCategoryId = category.id;
    return category;
}

async function isStaff(member) {
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    
    const staffRoles = await db.all('SELECT role_id FROM staff_roles');
    const staffRoleIds = staffRoles.map(r => r.role_id);
    return member.roles.cache.some(role => staffRoleIds.includes(role.id));
}

// ===================== COMANDOS =====================
client.once('ready', async () => {
    console.log(`✅ Eclipse Store Bot logado como ${client.user.tag}`);
    await initDatabase();
    
    // Registrar comandos slash
    const commands = [
        new SlashCommandBuilder()
            .setName('adm')
            .setDescription('Painel administrativo do sistema de tickets')
    ];
    
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    
    try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands.map(cmd => cmd.toJSON()) });
        console.log('✅ Comandos slash registrados!');
    } catch (error) {
        console.error('Erro ao registrar comandos:', error);
    }
});

// Comando !setup_ticket
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith('!setup_ticket')) return;
    
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return message.reply('❌ Apenas administradores podem usar este comando!');
    }
    
    await getOrCreateCategory(message.guild);
    
    const embed = new EmbedBuilder()
        .setTitle('ECLIPSE STORE - Central de Suporte')
        .setDescription(
            '### Central de Atendimento\n' +
            'Bem-vindo ao suporte.\n\n' +
            'Escolha uma opção no menu abaixo para abrir um canal privado com a equipe.\n\n' +
            '- Suporte geral\n- Denúncias\n- Ajuda com executores\n- Sugestões\n- Middleman\n\n' +
            '#### Status\n- Sistema online\n- Fila moderada'
        )
        .setColor(0x0099ff)
        .setFooter({ text: `Eclipse Store • Canais privados | ${new Date().toLocaleDateString('pt-BR')}` });
    
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('ticket_suporte')
                .setLabel('Suporte geral')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('ticket_denuncia')
                .setLabel('Denúncias')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId('ticket_executores')
                .setLabel('Ajuda com executores')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('ticket_sugestao')
                .setLabel('Sugestões')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('ticket_middleman')
                .setLabel('Middleman')
                .setStyle(ButtonStyle.Primary)
        );
    
    await message.channel.send({ embeds: [embed], components: [row] });
    await message.reply('✅ Painel de tickets enviado!');
});

// ===================== INTERAÇÕES =====================
client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton()) {
        await handleButton(interaction);
    } else if (interaction.isModalSubmit()) {
        await handleModal(interaction);
    } else if (interaction.isChatInputCommand() && interaction.commandName === 'adm') {
        await handleAdmCommand(interaction);
    }
});

async function handleButton(interaction) {
    const customId = interaction.customId;
    
    // Tickets
    if (customId.startsWith('ticket_')) {
        const categoryMap = {
            'ticket_suporte': 'Suporte geral',
            'ticket_denuncia': 'Denúncia',
            'ticket_executores': 'Ajuda com executores',
            'ticket_sugestao': 'Sugestões',
            'ticket_middleman': 'Middleman'
        };
        
        const category = categoryMap[customId];
        if (category) {
            await createTicket(interaction, category);
        }
        return;
    }
    
    // Controles do ticket
    if (customId === 'assumir') {
        await assumirTicket(interaction);
    } else if (customId === 'transcript') {
        await gerarTranscript(interaction);
    } else if (customId === 'info') {
        await infoTicket(interaction);
    } else if (customId === 'fechar') {
        await fecharTicket(interaction);
    }
    
    // Admin
    if (customId === 'admin_edit_msg') {
        const modal = new ModalBuilder()
            .setCustomId('modal_edit_msg')
            .setTitle('Editar mensagem do painel');
        
        const input = new TextInputBuilder()
            .setCustomId('msg_content')
            .setLabel('Nova mensagem')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);
        
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
    }
    
    if (customId === 'admin_edit_roles') {
        const modal = new ModalBuilder()
            .setCustomId('modal_edit_roles')
            .setTitle('Gerenciar cargos de staff');
        
        const actionInput = new TextInputBuilder()
            .setCustomId('action')
            .setLabel('Ação (add ou remove)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);
        
        const roleIdInput = new TextInputBuilder()
            .setCustomId('role_id')
            .setLabel('ID do cargo')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);
        
        modal.addComponents(
            new ActionRowBuilder().addComponents(actionInput),
            new ActionRowBuilder().addComponents(roleIdInput)
        );
        await interaction.showModal(modal);
    }
    
    if (customId === 'admin_cat_roles') {
        const modal = new ModalBuilder()
            .setCustomId('modal_cat_roles')
            .setTitle('Configurar cargo por categoria');
        
        const categoryInput = new TextInputBuilder()
            .setCustomId('category')
            .setLabel('Categoria (ex: Suporte geral)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);
        
        const roleIdInput = new TextInputBuilder()
            .setCustomId('role_id')
            .setLabel('ID do cargo (0 para remover)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);
        
        modal.addComponents(
            new ActionRowBuilder().addComponents(categoryInput),
            new ActionRowBuilder().addComponents(roleIdInput)
        );
        await interaction.showModal(modal);
    }
}

async function createTicket(interaction, categoryName) {
    const user = interaction.user;
    const guild = interaction.guild;
    
    // Verifica se já tem ticket aberto
    const existing = await db.get('SELECT channel_id FROM active_tickets WHERE user_id = ?', user.id);
    if (existing) {
        return interaction.reply({ content: '❌ Você já possui um ticket aberto! Feche o atual antes de abrir outro.', ephemeral: true });
    }
    
    const category = await getOrCreateCategory(guild);
    
    // Busca cargo específico da categoria
    const catRole = await db.get('SELECT role_id FROM category_roles WHERE category = ?', categoryName);
    const role = catRole ? guild.roles.cache.get(catRole.role_id) : null;
    
    // Permissões
    const permissionOverwrites = [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] }
    ];
    
    // Adiciona staff
    const staffRoles = await db.all('SELECT role_id FROM staff_roles');
    for (const staffRole of staffRoles) {
        const roleObj = guild.roles.cache.get(staffRole.role_id);
        if (roleObj) {
            permissionOverwrites.push({
                id: roleObj.id,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
            });
        }
    }
    
    const channel = await guild.channels.create({
        name: `ticket-${user.username.toLowerCase()}`,
        type: 0,
        parent: category.id,
        permissionOverwrites: permissionOverwrites
    });
    
    // Salva no banco
    await db.run(
        'INSERT INTO active_tickets (channel_id, user_id, category, created_at) VALUES (?, ?, ?, ?)',
        channel.id, user.id, categoryName, new Date().toISOString()
    );
    
    const embed = new EmbedBuilder()
        .setTitle('🎫 TICKET ABERTO')
        .setDescription(
            `Olá ${user},\n\nNossa equipe já foi notificada.\n---\n` +
            `**Usuário:** ${user}\n**Categoria:** ${categoryName}\n` +
            `**Data:** ${new Date().toLocaleString('pt-BR')}\n---\nAguarde um staff assumir.`
        )
        .setColor(0xffcc00);
    
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder().setCustomId('assumir').setLabel('Assumir').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('transcript').setLabel('Transcript').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('info').setLabel('Info').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('fechar').setLabel('Fechar').setStyle(ButtonStyle.Danger)
        );
    
    await channel.send({ embeds: [embed], components: [row] });
    
    if (role) {
        await channel.send({ content: `${role} - Novo ticket na categoria **${categoryName}**` });
    }
    
    await interaction.reply({ content: `✅ Ticket criado! ${channel}`, ephemeral: true });
}

async function assumirTicket(interaction) {
    const isStaffUser = await isStaff(interaction.member);
    if (!isStaffUser) {
        return interaction.reply({ content: '❌ Apenas staff pode assumir tickets!', ephemeral: true });
    }
    
    const ticket = await db.get('SELECT * FROM active_tickets WHERE channel_id = ?', interaction.channel.id);
    if (!ticket) return;
    
    if (ticket.staff_id) {
        return interaction.reply({ content: '❌ Este ticket já foi assumido!', ephemeral: true });
    }
    
    await db.run('UPDATE active_tickets SET staff_id = ? WHERE channel_id = ?', interaction.user.id, interaction.channel.id);
    await interaction.reply({ content: '✅ Você assumiu o ticket!', ephemeral: true });
    await interaction.channel.send({ content: `**${interaction.user} assumiu o atendimento.**` });
}

async function gerarTranscript(interaction) {
    const isStaffUser = await isStaff(interaction.member);
    if (!isStaffUser) {
        return interaction.reply({ content: '❌ Apenas staff pode gerar transcrição!', ephemeral: true });
    }
    
    await interaction.reply({ content: '📄 Gerando transcript...', ephemeral: true });
    
    const messages = await interaction.channel.messages.fetch({ limit: 200 });
    const logLines = [];
    
    messages.reverse().forEach(msg => {
        logLines.push(`${msg.author.tag} - ${msg.createdAt.toLocaleString()}: ${msg.content}`);
    });
    
    const transcript = logLines.join('\n');
    const fileName = `transcript_${interaction.channel.name}_${Date.now()}.txt`;
    fs.writeFileSync(fileName, transcript);
    
    if (LOG_CHANNEL_ID !== '0') {
        const logChannel = client.channels.cache.get(LOG_CHANNEL_ID);
        if (logChannel) {
            await logChannel.send({ files: [fileName] });
        } else {
            await interaction.user.send({ files: [fileName] });
        }
    } else {
        await interaction.user.send({ files: [fileName] });
    }
    
    fs.unlinkSync(fileName);
    await interaction.editReply({ content: '✅ Transcript gerado e enviado!' });
}

async function infoTicket(interaction) {
    const ticket = await db.get('SELECT * FROM active_tickets WHERE channel_id = ?', interaction.channel.id);
    if (!ticket) return;
    
    const embed = new EmbedBuilder()
        .setTitle('Informações do Ticket')
        .addFields(
            { name: 'Usuário', value: `<@${ticket.user_id}>` },
            { name: 'Categoria', value: ticket.category },
            { name: 'Staff responsável', value: ticket.staff_id ? `<@${ticket.staff_id}>` : 'Ninguém' },
            { name: 'Criado em', value: new Date(ticket.created_at).toLocaleString('pt-BR') }
        )
        .setColor(0x0099ff);
    
    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function fecharTicket(interaction) {
    const ticket = await db.get('SELECT * FROM active_tickets WHERE channel_id = ?', interaction.channel.id);
    if (!ticket) return;
    
    const isStaffUser = await isStaff(interaction.member);
    if (!isStaffUser && interaction.user.id !== ticket.user_id) {
        return interaction.reply({ content: '❌ Apenas o criador ou staff pode fechar!', ephemeral: true });
    }
    
    await interaction.reply({ content: '🔒 Fechando ticket em 5 segundos...' });
    setTimeout(async () => {
        await db.run('DELETE FROM active_tickets WHERE channel_id = ?', interaction.channel.id);
        await interaction.channel.delete();
    }, 5000);
}

async function handleAdmCommand(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ Apenas administradores!', ephemeral: true });
    }
    
    const embed = new EmbedBuilder()
        .setTitle('🔧 PAINEL ADMINISTRATIVO - ECLIPSE STORE')
        .setDescription('Selecione uma opção abaixo para configurar o sistema.')
        .setColor(0x00ff00)
        .addFields(
            { name: '📝 Editar mensagem do painel', value: 'Altere o texto da mensagem de boas-vindas.', inline: false },
            { name: '👥 Editar cargos de staff', value: 'Adicione/remova cargos que podem atender tickets.', inline: false },
            { name: '🔗 Configurar cargo por categoria', value: 'Defina qual cargo será notificado para cada tipo.', inline: false }
        );
    
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder().setCustomId('admin_edit_msg').setLabel('📝 Editar mensagem').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('admin_edit_roles').setLabel('👥 Editar cargos').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('admin_cat_roles').setLabel('🔗 Configurar cargos').setStyle(ButtonStyle.Secondary)
        );
    
    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

async function handleModal(interaction) {
    if (interaction.customId === 'modal_edit_msg') {
        const newMessage = interaction.fields.getTextInputValue('msg_content');
        await db.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', 'panel_message', newMessage);
        await interaction.reply({ content: '✅ Mensagem atualizada! Use !setup_ticket para enviar o novo painel.', ephemeral: true });
    }
    
    if (interaction.customId === 'modal_edit_roles') {
        const action = interaction.fields.getTextInputValue('action').toLowerCase();
        const roleId = interaction.fields.getTextInputValue('role_id');
        
        if (action === 'add') {
            await db.run('INSERT OR IGNORE INTO staff_roles (role_id) VALUES (?)', roleId);
            await interaction.reply({ content: `✅ Cargo ${roleId} adicionado aos staffs!`, ephemeral: true });
        } else if (action === 'remove') {
            await db.run('DELETE FROM staff_roles WHERE role_id = ?', roleId);
            await interaction.reply({ content: `✅ Cargo ${roleId} removido dos staffs!`, ephemeral: true });
        } else {
            await interaction.reply({ content: '❌ Ação inválida! Use "add" ou "remove".', ephemeral: true });
        }
    }
    
    if (interaction.customId === 'modal_cat_roles') {
        const category = interaction.fields.getTextInputValue('category');
        const roleId = interaction.fields.getTextInputValue('role_id');
        
        if (roleId === '0') {
            await db.run('DELETE FROM category_roles WHERE category = ?', category);
            await interaction.reply({ content: `✅ Cargo removido para categoria "${category}"!`, ephemeral: true });
        } else {
            await db.run('INSERT OR REPLACE INTO category_roles (category, role_id) VALUES (?, ?)', category, roleId);
            await interaction.reply({ content: `✅ Cargo ${roleId} configurado para categoria "${category}"!`, ephemeral: true });
        }
    }
}

// ===================== INICIALIZAÇÃO =====================
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
    console.error('❌ ERRO: Token não encontrado! Configure a variável DISCORD_TOKEN');
    process.exit(1);
}

client.login(TOKEN);