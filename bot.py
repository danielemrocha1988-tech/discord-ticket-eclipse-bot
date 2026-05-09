import discord
from discord import app_commands
from discord.ext import commands
import sqlite3
from datetime import datetime
import json
import os
import asyncio

# ===================== CONFIGURAÇÕES =====================
# COLOQUE SEUS IDs AQUI:
GUILD_ID = 123456789012345678        # ID do seu servidor
TICKET_CATEGORY_ID = 123456789012345678   # ID da categoria dos tickets
LOG_CHANNEL_ID = 123456789012345678      # ID do canal de logs

# ===================== BANCO DE DADOS =====================
conn = sqlite3.connect('tickets.db')
c = conn.cursor()

c.execute('''CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
)''')

c.execute('''CREATE TABLE IF NOT EXISTS category_roles (
    category TEXT PRIMARY KEY,
    role_id INTEGER
)''')

c.execute('''CREATE TABLE IF NOT EXISTS staff_roles (
    role_id INTEGER PRIMARY KEY
)''')

c.execute('''CREATE TABLE IF NOT EXISTS active_tickets (
    channel_id INTEGER PRIMARY KEY,
    user_id INTEGER,
    category TEXT,
    staff_id INTEGER,
    created_at TEXT
)''')
conn.commit()

# ===================== BOT =====================
class EclipseBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        intents.message_content = True
        intents.members = True
        super().__init__(command_prefix="!", intents=intents)
        self.synced = False

    async def setup_hook(self):
        await self.add_cog(TicketCog(self))
        if not self.synced:
            await self.tree.sync(guild=discord.Object(id=GUILD_ID))
            self.synced = True
            print("Comandos sincronizados!")

bot = EclipseBot()

class TicketCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    # ===================== MENU PRINCIPAL =====================
    @commands.command(name="setup_ticket")
    @commands.has_permissions(administrator=True)
    async def setup_ticket(self, ctx):
        """Envia o painel de criação de tickets"""
        embed = discord.Embed(
            title="ECLIPSE STORE - Central de Suporte",
            description=(
                "### Central de Atendimento\n"
                "Bem-vindo ao suporte.\n\n"
                "Escolha uma opção no menu abaixo para abrir um canal privado com a equipe.\n\n"
                "- Suporte geral\n- Denúncias\n- Ajuda com executores\n- Sugestões\n- Middleman\n\n"
                "#### Status\n- Sistema online\n- Fila moderada"
            ),
            color=discord.Color.blue()
        )
        embed.set_footer(text="Eclipse Store • Canais privados | " + datetime.now().strftime("%d/%m/%Y"))
        
        view = TicketMenuView()
        await ctx.send(embed=embed, view=view)
        await ctx.send("✅ Painel de tickets enviado!", delete_after=5)

    # ===================== COMANDOS /ADM =====================
    @app_commands.command(name="adm", description="Painel administrativo do sistema de tickets")
    @app_commands.guilds(discord.Object(id=GUILD_ID))
    async def adm_panel(self, interaction: discord.Interaction):
        # Verifica se é admin
        if not interaction.user.guild_permissions.administrator:
            await interaction.response.send_message("❌ Apenas administradores podem usar este comando!", ephemeral=True)
            return
            
        embed = discord.Embed(
            title="🔧 **PAINEL ADMINISTRATIVO - ECLIPSE STORE**",
            description="Selecione uma opção abaixo para configurar o sistema.",
            color=discord.Color.green()
        )
        embed.add_field(name="📝 Editar mensagem do painel", value="Altere o texto da mensagem de boas-vindas (1ª imagem).", inline=False)
        embed.add_field(name="👥 Editar cargos com acesso ao ticket", value="Adicione/remova cargos que podem visualizar e atender tickets.", inline=False)
        embed.add_field(name="🔗 Configurar cargo por categoria", value="Defina qual cargo será notificado para cada tipo de atendimento.", inline=False)
        
        view = AdminPanelView()
        await interaction.response.send_message(embed=embed, view=view, ephemeral=True)

    # ===================== LÓGICA DOS TICKETS =====================
    async def create_ticket(self, interaction: discord.Interaction, category_name: str):
        """Cria um canal privado de ticket e marca o cargo correspondente"""
        user = interaction.user
        guild = interaction.guild
        
        # Verifica se o usuário já tem ticket aberto
        c.execute("SELECT channel_id FROM active_tickets WHERE user_id = ?", (user.id,))
        if c.fetchone():
            await interaction.response.send_message("❌ Você já possui um ticket aberto! Feche o atual antes de abrir outro.", ephemeral=True)
            return
        
        # Busca o cargo específico da categoria
        c.execute("SELECT role_id FROM category_roles WHERE category = ?", (category_name,))
        row = c.fetchone()
        role_id = row[0] if row else None
        role = guild.get_role(role_id) if role_id else None
        
        # Cria o canal
        category = guild.get_channel(TICKET_CATEGORY_ID)
        if not category:
            await interaction.response.send_message("❌ Categoria de tickets não configurada.", ephemeral=True)
            return
        
        overwrites = {
            guild.default_role: discord.PermissionOverwrite(read_messages=False),
            user: discord.PermissionOverwrite(read_messages=True, send_messages=True, attach_files=True),
        }
        # Adiciona permissões para cargos de staff
        c.execute("SELECT role_id FROM staff_roles")
        staff_roles = c.fetchall()
        for (role_id,) in staff_roles:
            r = guild.get_role(role_id)
            if r:
                overwrites[r] = discord.PermissionOverwrite(read_messages=True, send_messages=True)
        
        channel = await guild.create_text_channel(
            name=f"ticket-{user.name.lower()}",
            category=category,
            overwrites=overwrites
        )
        
        # Salva no banco
        c.execute("INSERT INTO active_tickets (channel_id, user_id, category, created_at) VALUES (?, ?, ?, ?)",
                  (channel.id, user.id, category_name, datetime.now().isoformat()))
        conn.commit()
        
        # Mensagem inicial no canal
        embed = discord.Embed(
            title="🎫 **TICKET ABERTO**",
            description=f"Olá {user.mention},\n\nNossa equipe já foi notificada.\n---\n**Usuário:** {user.mention}\n**Categoria:** {category_name}\n**Data:** {datetime.now().strftime('%d/%m/%Y às %H:%M')}\n---\nAguarde um staff assumir.",
            color=discord.Color.gold()
        )
        view = TicketControlView(channel.id, user.id, category_name)
        await channel.send(embed=embed, view=view)
        
        # Marca o cargo específico (se existir)
        if role:
            await channel.send(f"{role.mention} - Novo ticket na categoria **{category_name}**", delete_after=5)
        
        # Notifica o usuário
        await interaction.response.send_message(f"✅ Ticket criado! {channel.mention}", ephemeral=True)

# ===================== VIEWS (BOTÕES) =====================
class TicketMenuView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)
    
    @discord.ui.button(label="Suporte geral", style=discord.ButtonStyle.primary, custom_id="ticket_suporte")
    async def suporte_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.handle_ticket(interaction, "Suporte geral")
    
    @discord.ui.button(label="Denúncias", style=discord.ButtonStyle.danger, custom_id="ticket_denuncia")
    async def denuncia_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.handle_ticket(interaction, "Denúncia")
    
    @discord.ui.button(label="Ajuda com executores", style=discord.ButtonStyle.secondary, custom_id="ticket_executores")
    async def executores_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.handle_ticket(interaction, "Ajuda com executores")
    
    @discord.ui.button(label="Sugestões", style=discord.ButtonStyle.success, custom_id="ticket_sugestao")
    async def sugestao_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.handle_ticket(interaction, "Sugestões")
    
    @discord.ui.button(label="Middleman", style=discord.ButtonStyle.blurple, custom_id="ticket_middleman")
    async def middleman_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.handle_ticket(interaction, "Middleman")
    
    async def handle_ticket(self, interaction: discord.Interaction, category: str):
        cog = interaction.client.get_cog("TicketCog")
        await cog.create_ticket(interaction, category)

class TicketControlView(discord.ui.View):
    def __init__(self, channel_id, user_id, category):
        super().__init__(timeout=None)
        self.channel_id = channel_id
        self.user_id = user_id
        self.category = category
        self.staff_id = None
    
    @discord.ui.button(label="Assumir", style=discord.ButtonStyle.primary, custom_id="ticket_assumir")
    async def assumir_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if self.staff_id is not None:
            await interaction.response.send_message("❌ Este ticket já foi assumido por outro staff.", ephemeral=True)
            return
        
        # Verifica se é staff
        c.execute("SELECT role_id FROM staff_roles")
        staff_roles = [row[0] for row in c.fetchall()]
        is_staff = any(role.id in staff_roles for role in interaction.user.roles)
        
        if not is_staff:
            await interaction.response.send_message("❌ Apenas staff pode assumir tickets!", ephemeral=True)
            return
            
        self.staff_id = interaction.user.id
        c.execute("UPDATE active_tickets SET staff_id = ? WHERE channel_id = ?", (self.staff_id, self.channel_id))
        conn.commit()
        await interaction.response.send_message(f"✅ Você assumiu o ticket!", ephemeral=True)
        await interaction.channel.send(f"**{interaction.user.mention} assumiu o atendimento.**")
    
    @discord.ui.button(label="Transcript", style=discord.ButtonStyle.secondary, custom_id="ticket_transcript")
    async def transcript_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        c.execute("SELECT role_id FROM staff_roles")
        staff_roles = [row[0] for row in c.fetchall()]
        is_staff = any(role.id in staff_roles for role in interaction.user.roles) or interaction.user.guild_permissions.administrator
        
        if not is_staff:
            await interaction.response.send_message("❌ Apenas staff pode gerar transcrição.", ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True)
        
        messages = []
        async for msg in interaction.channel.history(limit=200):
            messages.append(f"{msg.author} - {msg.created_at}: {msg.content}")
        transcript = "\n".join(reversed(messages))
        filename = f"transcript_{interaction.channel.name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
        with open(filename, "w", encoding="utf-8") as f:
            f.write(transcript)
        log_channel = interaction.guild.get_channel(LOG_CHANNEL_ID)
        if log_channel:
            await log_channel.send(file=discord.File(filename))
        else:
            await interaction.user.send(file=discord.File(filename))
        os.remove(filename)
        await interaction.followup.send("✅ Transcript gerado e enviado.", ephemeral=True)
    
    @discord.ui.button(label="Info", style=discord.ButtonStyle.secondary, custom_id="ticket_info")
    async def info_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        embed = discord.Embed(title="Informações do Ticket", color=discord.Color.blue())
        embed.add_field(name="Usuário", value=f"<@{self.user_id}>")
        embed.add_field(name="Categoria", value=self.category)
        embed.add_field(name="Staff responsável", value=f"<@{self.staff_id}>" if self.staff_id else "Ninguém")
        embed.add_field(name="Criado em", value=datetime.now().strftime("%d/%m/%Y %H:%M"))
        await interaction.response.send_message(embed=embed, ephemeral=True)
    
    @discord.ui.button(label="Fechar", style=discord.ButtonStyle.danger, custom_id="ticket_fechar")
    async def fechar_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        c.execute("SELECT role_id FROM staff_roles")
        staff_roles = [row[0] for row in c.fetchall()]
        is_staff = any(role.id in staff_roles for role in interaction.user.roles) or interaction.user.guild_permissions.administrator
        
        if not is_staff and interaction.user.id != self.user_id:
            await interaction.response.send_message("❌ Apenas o criador do ticket ou staff pode fechar.", ephemeral=True)
            return
        await interaction.response.send_message("🔒 Fechando ticket em 5 segundos...")
        await asyncio.sleep(5)
        c.execute("DELETE FROM active_tickets WHERE channel_id = ?", (self.channel_id,))
        conn.commit()
        await interaction.channel.delete()

class AdminPanelView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)
    
    @discord.ui.button(label="📝 Editar mensagem do painel", style=discord.ButtonStyle.secondary, custom_id="admin_edit_msg")
    async def edit_message_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(EditMessageModal())
    
    @discord.ui.button(label="👥 Editar cargos de staff", style=discord.ButtonStyle.secondary, custom_id="admin_edit_roles")
    async def edit_staff_roles_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(StaffRolesModal())
    
    @discord.ui.button(label="🔗 Configurar cargo por categoria", style=discord.ButtonStyle.secondary, custom_id="admin_cat_roles")
    async def category_roles_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(CategoryRoleModal())

# ===================== MODAIS =====================
class EditMessageModal(discord.ui.Modal, title="Editar mensagem do painel"):
    message_content = discord.ui.TextInput(label="Nova mensagem (embed description)", style=discord.TextStyle.paragraph, required=True)
    
    async def on_submit(self, interaction: discord.Interaction):
        c.execute("INSERT OR REPLACE INTO config (key, value) VALUES ('panel_message', ?)", (self.message_content.value,))
        conn.commit()
        await interaction.response.send_message("✅ Mensagem do painel atualizada! Use !setup_ticket novamente para enviar o novo painel.", ephemeral=True)

class StaffRolesModal(discord.ui.Modal, title="Gerenciar cargos de staff"):
    action = discord.ui.TextInput(label="Ação: add ou remove", placeholder="add ou remove", required=True)
    role_id = discord.ui.TextInput(label="ID do cargo", required=True)
    
    async def on_submit(self, interaction: discord.Interaction):
        try:
            role_id = int(self.role_id.value)
            if self.action.value.lower() == "add":
                c.execute("INSERT OR IGNORE INTO staff_roles (role_id) VALUES (?)", (role_id,))
                conn.commit()
                await interaction.response.send_message(f"✅ Cargo {role_id} adicionado aos staffs.", ephemeral=True)
            elif self.action.value.lower() == "remove":
                c.execute("DELETE FROM staff_roles WHERE role_id = ?", (role_id,))
                conn.commit()
                await interaction.response.send_message(f"✅ Cargo {role_id} removido dos staffs.", ephemeral=True)
            else:
                await interaction.response.send_message("❌ Ação inválida. Use 'add' ou 'remove'.", ephemeral=True)
        except ValueError:
            await interaction.response.send_message("❌ ID do cargo inválido.", ephemeral=True)

class CategoryRoleModal(discord.ui.Modal, title="Definir cargo por categoria"):
    category = discord.ui.TextInput(label="Categoria (ex: Suporte geral)", required=True)
    role_id = discord.ui.TextInput(label="ID do cargo (ou 0 para remover)", required=True)
    
    async def on_submit(self, interaction: discord.Interaction):
        try:
            role_id = int(self.role_id.value)
            if role_id == 0:
                c.execute("DELETE FROM category_roles WHERE category = ?", (self.category.value,))
            else:
                c.execute("INSERT OR REPLACE INTO category_roles (category, role_id) VALUES (?, ?)", (self.category.value, role_id))
            conn.commit()
            await interaction.response.send_message(f"✅ Cargo configurado para categoria '{self.category.value}'.", ephemeral=True)
        except ValueError:
            await interaction.response.send_message("❌ ID inválido.", ephemeral=True)

# ===================== EVENTO DE PRONTO =====================
@bot.event
async def on_ready():
    print(f"Eclipse Store Bot logado como {bot.user}")
    try:
        synced = await bot.tree.sync()
        print(f"Comandos sincronizados: {len(synced)}")
    except Exception as e:
        print(e)

# ===================== INICIALIZAÇÃO =====================
if __name__ == "__main__":
    TOKEN = os.getenv("DISCORD_TOKEN")
    if not TOKEN:
        print("ERRO: Token não encontrado! Configure a variável DISCORD_TOKEN")
    else:
        bot.run(TOKEN)