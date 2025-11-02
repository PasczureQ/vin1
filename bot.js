require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const POLL_INTERVAL = (process.env.POLL_INTERVAL_SEC ? parseInt(process.env.POLL_INTERVAL_SEC) : 60) * 1000;
const CONFIG_PATH = process.env.CONFIG_JSON || 'config.json';
const SEEN_PATH = path.join(__dirname, 'seen.json');

if (!TOKEN || !CHANNEL_ID) {
  console.error('Brakuje DISCORD_TOKEN lub CHANNEL_ID w .env');
  process.exit(1);
}

let seen = {};
if (fs.existsSync(SEEN_PATH)) {
  try { seen = JSON.parse(fs.readFileSync(SEEN_PATH)); } catch(e){ seen = {}; }
}

function saveSeen(){ fs.writeFileSync(SEEN_PATH, JSON.stringify(seen, null, 2)); }

function parsePrice(text){
  if (!text) return null;
  const cleaned = text.replace(/[^0-9.,-]/g, '').trim();
  if (!cleaned) return null;
  const normal = cleaned.replace(/\s+/g,'').replace(',', '.');
  const num = parseFloat(normal);
  return isNaN(num) ? null : num;
}

async function fetchHtml(url){
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StealFinder/1.0)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function makeAbsoluteLink(base, href){
  try { return new URL(href, base).href; } catch(e) { return href; }
}

async function checkWatch(w, channel){
  try{
    const html = await fetchHtml(w.url);
    const $ = cheerio.load(html);
    const items = $(w.itemSelector).toArray();
    for (const el of items){
      const $el = $(el);
      const title = (w.titleSelector ? $el.find(w.titleSelector).first().text().trim() : $el.text().trim()) || 'Brak tytułu';
      let priceText = w.priceSelector ? $el.find(w.priceSelector).first().text().trim() : null;
      let price = parsePrice(priceText);
      if (price == null){
        const maybe = ($el.text().match(/([0-9][0-9 .,]{0,10}[0-9])/g) || [])[0];
        price = parsePrice(maybe);
        priceText = maybe || priceText;
      }
      const linkEl = $el.find(w.linkSelector).first();
      let href = linkEl.attr('href') || linkEl.data('href') || null;
      const link = href ? makeAbsoluteLink(w.url, href) : w.url;

      if (price == null) continue;

      const id = (link || title) + '|' + (price || '');
      if (seen[id]) continue;

      const meetsPrice = (typeof w.maxPrice === 'number') ? (price <= w.maxPrice) : true;
      let profit = null;
      let meetsProfit = true;
      if (typeof w.expectedResaleValue === 'number'){
        profit = w.expectedResaleValue - price;
        if (typeof w.minProfit === 'number') meetsProfit = profit >= w.minProfit;
      }

      if (meetsPrice && meetsProfit){
        const embed = new EmbedBuilder()
          .setTitle(title)
          .setURL(link)
          .addFields(
            { name: 'Cena', value: `${priceText || price}`, inline: true },
            { name: 'Próg (maxPrice)', value: `${w.maxPrice || 'brak'}`, inline: true }
          )
          .setTimestamp();

        if (profit !== null) embed.addFields({ name: 'Szacowany zysk', value: `${profit}`, inline: true });

        try{
          await channel.send({ embeds: [embed] });
          console.log('Wysłano powiadomienie:', title, price);
          seen[id] = { ts: Date.now(), title, price, link };
          saveSeen();
        } catch(e){
          console.error('Błąd wysyłania wiadomości do Discord:', e.message);
        }

        // krótka pauza
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  } catch(e){
    console.error('Błąd przy sprawdzaniu', w.name, e.message);
  }
}

async function main(){
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

  client.once('ready', async () => {
    console.log(`Zalogowano jako ${client.user.tag}`);
    const channel = await client.channels.fetch(CHANNEL_ID).catch(()=>null);
    if (!channel) {
      console.error('Nie mogę znaleźć kanału o podanym CHANNEL_ID. Sprawdź .env');
      process.exit(1);
    }

    let config = [];
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH));
    } catch(e){
      console.error('Nie mogę wczytać config.json — upewnij się że plik istnieje i jest poprawny JSON.');
      process.exit(1);
    }

    // pierwotne sprawdzenie
    const runChecks = async () => {
      for (const w of config){
        await checkWatch(w, channel);
      }
    };

    await runChecks();
    setInterval(runChecks, POLL_INTERVAL);
  });

  client.login(TOKEN);
}

main();
