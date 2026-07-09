# 🛰️ NetNOC

Dashboard de monitoramento de rede em tempo real, feito para rodar em um Raspberry Pi (ou qualquer Linux) com consumo baixo de CPU/RAM. Interface inspirada em ferramentas de NOC (Grafana/UniFi/Zabbix), 100% self-hosted, sem depender de serviços externos além dos alvos que você monitora.

![Python](https://img.shields.io/badge/Python-3.9%2B-blue)
![FastAPI](https://img.shields.io/badge/FastAPI-backend-009688)
![License](https://img.shields.io/badge/license-MIT-green)

---

## ✨ Funcionalidades

- **Ping em tempo real** — latência, jitter e perda de pacotes por destino, atualização a cada poucos segundos
- **Uptime 24h** e **barras de disponibilidade** por hora, estilo status page
- **Detecção de padrões** — identifica sozinho horários recorrentes de instabilidade (ex: "Gateway costuma cair por volta das 19h")
- **Comparação de DNS** entre múltiplos servidores (Google, Cloudflare, Quad9, etc.)
- **Teste de velocidade** sob demanda (Cloudflare)
- **Monitoramento de sistema** — CPU, memória e temperatura do próprio Raspberry Pi
- **Incidentes automáticos** — abre e resolve sozinho (latência alta, jitter, perda, offline, CPU/temperatura alta), com timeline de eventos
- **Alertas via Telegram** configuráveis por severidade
- **Ícones reais das marcas** (Google, Instagram, Discord, etc.) detectados automaticamente pelo nome/host cadastrado
- **5 temas de cores** (azul, verde, roxo, OLED preto, claro)
- **Dashboard 100% arrastável** — reorganize os painéis do jeito que quiser, arrastando pelo título; layout salvo no navegador
- **Tudo configurável pela própria interface** — adicionar/remover destinos, servidores DNS, intervalos de coleta e alertas sem editar nenhum arquivo
- **Banco SQLite embutido**, sem precisar instalar/configurar banco externo

---

## 🧰 Requisitos

- Python 3.9 ou superior
- Linux (testado em Raspberry Pi OS / DietPi), também funciona em qualquer distro ou no Windows
- Acesso à internet no dispositivo (para ping, DNS, IP público e speedtest)

---

## 🚀 Instalação

```bash
git clone https://github.com/SEU_USUARIO/netnoc.git
cd netnoc
chmod +x install.sh
./install.sh
```

O script `install.sh`:
1. Verifica se `gcc` e `python3-dev` estão instalados (necessários para compilar o `psutil`) e instala automaticamente se faltar
2. Cria um ambiente virtual Python (`venv`)
3. Instala as dependências (`requirements.txt`)

### Instalação manual (se preferir)

```bash
sudo apt-get update
sudo apt-get install -y gcc python3-dev python3-venv

python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

---

## ▶️ Rodando

```bash
source venv/bin/activate
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000
```

Acesse pelo navegador de qualquer dispositivo na mesma rede:

```
http://IP_DO_DISPOSITIVO:8000
```

Pra descobrir o IP do Raspberry Pi: `hostname -I`

---

## ⚙️ Configuração inicial

Nada precisa ser editado em arquivo — tudo é feito pela aba **Configurações** do próprio dashboard:

- **Destinos (Ping)** — adicione qualquer host/IP que queira monitorar (sites, servidores, seu gateway, etc.)
- **Servidores DNS** — servidores DNS para comparar tempo de resposta (não confundir com destinos/sites)
- **Intervalos de Coleta** — frequência de ping, DNS, IP público e coleta de sistema
- **Alertas Telegram** — ativa notificações automáticas quando um incidente abre

Valores padrão iniciais (targets/DNS) ficam em `config.json`, usado apenas na primeira execução para popular o banco — depois disso, tudo é gerenciado via SQLite e pela interface.

### Configurando alertas no Telegram

1. Fale com **[@BotFather](https://t.me/BotFather)** no Telegram e crie um bot (`/newbot`) — ele te dará um **token**
2. Envie qualquer mensagem para o seu bot recém-criado
3. Acesse no navegador: `https://api.telegram.org/bot<SEU_TOKEN>/getUpdates` e pegue o `chat_id` da resposta
4. Cole token + chat_id na aba **Configurações → Alertas Telegram**, ative e clique em **Enviar Teste**

---

## 🔁 Rodando automaticamente no boot (systemd)

Crie o serviço:

```bash
sudo nano /etc/systemd/system/netnoc.service
```

Cole (ajuste o caminho se instalou em outro lugar):

```ini
[Unit]
Description=NetNOC
After=network.target

[Service]
WorkingDirectory=/caminho/para/netnoc
ExecStart=/caminho/para/netnoc/venv/bin/python3 -m uvicorn main:app --host 0.0.0.0 --port 8000
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

Ative:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now netnoc
```

Comandos úteis:

```bash
sudo systemctl status netnoc      # ver status
sudo systemctl restart netnoc     # reiniciar
journalctl -u netnoc -f           # ver logs em tempo real
```

---

## 🗂️ Estrutura do projeto

```
netnoc/
├── main.py           # API FastAPI (endpoints /api/...) + serve o frontend estático
├── monitor.py         # Workers em background: ping, DNS, IP público, sistema, incidentes, Telegram
├── db.py              # Camada SQLite (netnoc.db é criado automaticamente)
├── config.json        # Valores iniciais (usados só na primeira execução)
├── requirements.txt
├── install.sh
└── static/
    ├── index.html
    ├── style.css
    ├── app.js
    ├── chart.umd.js   # Chart.js embutido localmente (sem depender de CDN)
    └── icons.js        # Ícones de marcas embutidos localmente (sem depender de CDN)
```

---

## 🧹 Limpando o histórico

Pelo dashboard: botão **"🗑 Limpar Histórico"** na barra lateral (com confirmação).

Ou manualmente:

```bash
sudo systemctl stop netnoc
rm netnoc.db
sudo systemctl start netnoc
```

---

## 🛠️ Notas técnicas

- Ping usa o comando `ping` do sistema operacional — não precisa rodar como root
- Teste de velocidade usa os endpoints públicos `speed.cloudflare.com`
- Chart.js e os ícones de marca ficam **embutidos localmente** (não via CDN), evitando bloqueios por proteção de rastreamento de navegadores (Edge/Brave/Firefox)
- Histórico mantido por 30 dias por padrão (configurável em `config.json` → `history_retention_days`)
- Processo único, leve o suficiente para rodar em um Raspberry Pi 3/4

---

## 📄 Licença

MIT — use, modifique e distribua livremente.
