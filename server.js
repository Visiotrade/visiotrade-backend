 require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: [
    'https://visiotrade-shop.vercel.app',
    'https://*.vercel.app',
    'http://localhost:3000'
  ]
}));

app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use('/webhook/paypal', express.raw({ type: 'application/json' }));
app.use(express.json());

// ============================
// SUPABASE HELPER
// ============================
async function supabaseQuery(table, params = '') {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${table}${params}`;
  const res = await fetch(url, {
    headers: {
      'apikey': process.env.SUPABASE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });
  return res.json();
}

async function supabaseInsert(table, data) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': process.env.SUPABASE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      'Accept': 'application/json'
    },
    body: JSON.stringify(data)
  });
  return res.json();
}

async function supabaseUpdate(table, id, data) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey': process.env.SUPABASE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(data)
  });
  return res.ok;
}

// ============================
// EMAIL HELPER (Brevo HTTP API)
// ============================
async function sendeEmail(to, subject, html, pdfBuffer = null) {
  const body = {
    sender: { name: 'VisioTrade GmbH', email: 'visiotradegmbh@gmail.com' },
    to: [{ email: to }],
    subject,
    htmlContent: html
  };

  if (pdfBuffer) {
    body.attachment = [{
      name: 'Rechnung_VisioTrade.pdf',
      content: pdfBuffer.toString('base64')
    }];
  }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brevo Fehler: ${err}`);
  }
  return res.json();
}

// ============================
// TELEGRAM HELPER
// ============================
async function sendeTelegram(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
  const data = await res.json();
  if (!data.ok) console.error('Telegram Fehler:', data);
}

async function sendeAdminBenachrichtigung(bestellung) {
  const adminId = process.env.ADMIN_TELEGRAM_ID || process.env.TELEGRAM_ADMIN_ID;
  if (!adminId) { console.error('Kein Admin Telegram ID!'); return; }
  const text = `🛒 <b>Neue Bestellung #${bestellung.id}</b>\n\n` +
    `👤 Kunde: ${bestellung.kundenname}\n` +
    `📧 Email: ${bestellung.email}\n` +
    `💰 Netto: ${parseFloat(bestellung.gesamtbetrag).toFixed(2)} €\n` +
    `💰 MwSt: ${(parseFloat(bestellung.gesamtbetrag) * 0.19).toFixed(2)} €\n` +
    `💰 Brutto: ${(parseFloat(bestellung.gesamtbetrag) * 1.19).toFixed(2)} €\n` +
    `🚚 Lieferart: ${bestellung.lieferart}\n` +
    `💳 Zahlung: ${bestellung.zahlungsart}\n` +
    `📊 Status: Bezahlt ✅`;
  await sendeTelegram(adminId, text);
}

// ============================
// LEXOFFICE HELPER
// ============================
async function erstelleLexofficeRechnung(bestellung, positionen) {
  const netto = parseFloat(bestellung.gesamtbetrag);
  const mwst = netto * 0.19;
  const brutto = netto * 1.19;
  const rechnung = {
    voucherDate: new Date().toISOString(),
    address: {
      name: bestellung.kundenname,
      street: bestellung.lieferadresse_strasse || '',
      zip: bestellung.lieferadresse_plz || '',
      city: bestellung.lieferadresse_ort || '',
      countryCode: 'DE'
    },
    lineItems: positionen.map(pos => ({
      type: 'custom',
      name: pos.produktname,
      quantity: pos.menge_m2_gesamt,
      unitName: 'm²',
      unitPrice: {
        currency: 'EUR',
        netAmount: Math.round((pos.preis_je_paket / (pos.menge_m2_gesamt / pos.anzahl_pakete)) * 10000) / 10000,
        taxRatePercentage: 19
      },
      discountPercentage: 0
    })),
    totalPrice: { currency: 'EUR', totalNetAmount: netto, totalTaxAmount: mwst, totalGrossAmount: brutto },
    taxConditions: { taxType: 'net' },
    paymentConditions: { paymentTermLabel: 'Sofortzahlung', paymentTermDuration: 0 },
    shippingConditions: { shippingType: 'none' },
    introduction: 'Vielen Dank für Ihren Einkauf bei VisioTrade GmbH.',
    remark: 'Bitte überweisen Sie den Betrag auf unser Konto.'
  };

  // Schritt 1: Rechnung erstellen
  const res = await fetch('https://api.lexoffice.io/v1/invoices?finalize=true', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.LEXOFFICE_API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(rechnung)
  });

  if (!res.ok) { console.error('Lexoffice Fehler:', await res.text()); return null; }
  const result = await res.json();
  console.log(`✅ Lexoffice Rechnung angelegt: ${result.id}`);

  // Schritt 2: PDF-Rendering auslösen
  console.log(`🔄 Löse PDF-Rendering aus...`);
  const renderRes = await fetch(`https://api.lexoffice.io/v1/invoices/${result.id}/document`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${process.env.LEXOFFICE_API_KEY}`,
      'Accept': 'application/json'
    }
  });

  let pdfBuffer = null;

  if (renderRes.ok) {
    const renderData = await renderRes.json();
    const documentFileId = renderData.documentFileId;
    console.log(`✅ PDF DocumentFileId: ${documentFileId}`);

    // Schritt 3: PDF herunterladen
    await new Promise(resolve => setTimeout(resolve, 3000));
    const pdfRes = await fetch(`https://api.lexoffice.io/v1/files/${documentFileId}`, {
      headers: {
        'Authorization': `Bearer ${process.env.LEXOFFICE_API_KEY}`,
        'Accept': 'application/pdf'
      }
    });

    if (pdfRes.ok) {
      pdfBuffer = await pdfRes.buffer();
      console.log(`✅ PDF heruntergeladen (${pdfBuffer.length} bytes)`);
    } else {
      console.error(`❌ PDF Download Fehler: ${pdfRes.status}`);
    }
  } else {
    console.error(`❌ PDF Rendering Fehler: ${renderRes.status} - ${await renderRes.text()}`);
  }

  return { id: result.id, pdfBuffer };
}

// ============================
// NACH ZAHLUNG: Alles abwickeln
// ============================
async function bestellungAbwickeln(bestellungId, zahlungsId) {
  console.log(`🔄 Starte Abwicklung für Bestellung ${bestellungId}`);
  try {
    const bestellungen = await supabaseQuery('bestellungen', `?id=eq.${bestellungId}`);
    if (!bestellungen || !Array.isArray(bestellungen) || !bestellungen[0]) {
      console.error(`❌ Bestellung ${bestellungId} nicht gefunden`);
      return;
    }
    const bestellung = bestellungen[0];
    console.log(`✅ Bestellung geladen: ${bestellung.kundenname}`);

    const positionen = await supabaseQuery('bestellpositionen', `?bestellung_id=eq.${bestellungId}`);
    await supabaseUpdate('bestellungen', bestellungId, { status: 'bezahlt', zahlungs_id: zahlungsId });
    console.log(`✅ Status auf bezahlt gesetzt`);

    for (const pos of positionen) {
      if (pos.paket_id) {
        const pakete = await supabaseQuery('pakete', `?id=eq.${pos.paket_id}`);
        if (pakete && pakete[0]) {
          const neuerLager = Math.max(0, pakete[0].verfuegbare_pakete - pos.anzahl_pakete);
          await supabaseUpdate('pakete', pos.paket_id, { verfuegbare_pakete: neuerLager });
        }
      }
    }
    console.log(`✅ Lager aktualisiert`);

    let pdfBuffer = null;
    let lexofficeId = null;
    if (process.env.LEXOFFICE_API_KEY) {
      console.log(`🔄 Erstelle Lexoffice Rechnung...`);
      const lexResult = await erstelleLexofficeRechnung(bestellung, positionen);
      if (lexResult) {
        lexofficeId = lexResult.id;
        pdfBuffer = lexResult.pdfBuffer;
        await supabaseUpdate('bestellungen', bestellungId, { lexoffice_id: lexofficeId });
        console.log(`✅ Lexoffice Rechnung erstellt: ${lexofficeId}`);
      }
    }

    const netto = parseFloat(bestellung.gesamtbetrag);
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #3D2B1F; padding: 20px; text-align: center;">
          <h1 style="color: #C49A2B; font-family: Georgia, serif; margin: 0;">VisioTrade</h1>
          <p style="color: white; margin: 5px 0 0;">Premium Parkett</p>
        </div>
        <div style="padding: 30px; background: #FAF7F2;">
          <h2 style="color: #3D2B1F;">Vielen Dank für Ihre Bestellung!</h2>
          <p>Sehr geehrte/r ${bestellung.kundenname},</p>
          <p>Ihre Bestellung wurde erfolgreich aufgenommen und bezahlt.</p>
          <table style="width:100%; border-collapse:collapse; margin: 20px 0;">
            <tr style="background:#F5EDD8;"><td style="padding:10px; font-weight:bold;">Bestellnummer</td><td style="padding:10px;">#${bestellungId}</td></tr>
            <tr><td style="padding:10px; font-weight:bold;">Nettobetrag</td><td style="padding:10px;">${netto.toFixed(2).replace('.', ',')} €</td></tr>
            <tr style="background:#F5EDD8;"><td style="padding:10px; font-weight:bold;">MwSt. 19%</td><td style="padding:10px;">${(netto * 0.19).toFixed(2).replace('.', ',')} €</td></tr>
            <tr><td style="padding:10px; font-weight:bold; font-size:16px;">Gesamtbetrag</td><td style="padding:10px; font-weight:bold; font-size:16px; color:#8B6914;">${(netto * 1.19).toFixed(2).replace('.', ',')} €</td></tr>
            <tr style="background:#F5EDD8;"><td style="padding:10px; font-weight:bold;">Lieferart</td><td style="padding:10px;">${bestellung.lieferart === 'abholung' ? 'Selbstabholung' : 'Lieferung'}</td></tr>
          </table>
          ${pdfBuffer ? '<p>Ihre Rechnung finden Sie im Anhang dieser Email.</p>' : ''}
          <p style="color: #6B7280; font-size: 13px; margin-top: 30px;">Bei Fragen stehen wir Ihnen gerne zur Verfügung.<br>VisioTrade GmbH</p>
        </div>
      </div>
    `;

    if (bestellung.email) {
      console.log(`🔄 Sende Email an ${bestellung.email}...`);
      try {
        await sendeEmail(bestellung.email, `Ihre Bestellung #${bestellungId} bei VisioTrade — Bestätigung & Rechnung`, emailHtml, pdfBuffer);
        console.log(`✅ Email gesendet an ${bestellung.email}`);
      } catch (emailErr) {
        console.error(`❌ Email Fehler:`, emailErr.message);
      }
    }

    if (bestellung.telegram_user_id) {
      const telegramText = `✅ <b>Bestellung bestätigt!</b>\n\nBestellung #${bestellungId}\nNetto: ${netto.toFixed(2)} €\nMwSt. 19%: ${(netto * 0.19).toFixed(2)} €\n<b>Gesamt: ${(netto * 1.19).toFixed(2)} €</b>\n\n📧 Rechnung wurde an ${bestellung.email} gesendet.\n\nVielen Dank für Ihren Einkauf bei VisioTrade! 🪵`;
      await sendeTelegram(bestellung.telegram_user_id, telegramText);
    }

    console.log(`🔄 Sende Admin Benachrichtigung...`);
    await sendeAdminBenachrichtigung(bestellung);
    console.log(`✅ Bestellung ${bestellungId} vollständig abgewickelt`);

  } catch (err) {
    console.error(`❌ Fehler bei Bestellabwicklung:`, err);
  }
}

// ============================
// STRIPE: Checkout Session erstellen
// ============================
app.post('/api/stripe/create-session', async (req, res) => {
  try {
    const { bestellung_id, items, kundenname, email, netto } = req.body;
    console.log(`🔄 Erstelle Stripe Session für Bestellung ${bestellung_id}`);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: email,
      line_items: items.map(item => ({
        price_data: {
          currency: 'eur',
          product_data: { name: item.name, description: `${item.gesamt_m2} m²` },
          unit_amount: Math.round(item.preis * 119)
        },
        quantity: 1
      })),
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}?success=1&bestellung_id=${bestellung_id}`,
      cancel_url: `${process.env.FRONTEND_URL}?cancelled=1`,
      metadata: { bestellung_id: String(bestellung_id) },
      locale: 'de'
    });
    console.log(`✅ Stripe Session erstellt: ${session.id}`);
    res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Stripe Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================
// STRIPE: Webhook
// ============================
app.post('/webhook/stripe', async (req, res) => {
  let event;
  try {
    const payload = req.body.toString('utf8');
    event = JSON.parse(payload);
  } catch (err) {
    console.error('❌ Webhook Parse Fehler:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`✅ Webhook empfangen: ${event.type}`);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const bestellungId = parseInt(session.metadata.bestellung_id);
    console.log(`🔄 Zahlung abgeschlossen für Bestellung ${bestellungId}`);
    await bestellungAbwickeln(bestellungId, session.payment_intent);
  }

  res.json({ received: true });
});

// ============================
// PAYPAL
// ============================
async function getPayPalToken() {
  const res = await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json();
  return data.access_token;
}

app.post('/api/paypal/create-order', async (req, res) => {
  try {
    const { bestellung_id, netto, kundenname } = req.body;
    const brutto = (netto * 1.19).toFixed(2);
    const token = await getPayPalToken();
    const order = await fetch('https://api-m.sandbox.paypal.com/v2/checkout/orders', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: String(bestellung_id), amount: { currency_code: 'EUR', value: brutto }, description: `VisioTrade Bestellung #${bestellung_id}` }],
        application_context: { return_url: `${process.env.FRONTEND_URL}?success=1&bestellung_id=${bestellung_id}&zahlung=paypal`, cancel_url: `${process.env.FRONTEND_URL}?cancelled=1`, locale: 'de-DE', brand_name: 'VisioTrade GmbH' }
      })
    });
    const orderData = await order.json();
    const approveLink = orderData.links?.find(l => l.rel === 'approve')?.href;
    res.json({ url: approveLink, order_id: orderData.id });
  } catch (err) {
    console.error('❌ PayPal Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/paypal/capture/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { bestellung_id } = req.body;
    const token = await getPayPalToken();
    const capture = await fetch(`https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    const captureData = await capture.json();
    if (captureData.status === 'COMPLETED') {
      await bestellungAbwickeln(parseInt(bestellung_id), orderId);
    }
    res.json({ status: captureData.status });
  } catch (err) {
    console.error('❌ PayPal Capture Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================
// HEALTH CHECK
// ============================
app.get('/', (req, res) => {
  res.json({ status: 'VisioTrade Backend läuft ✅', time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`✅ VisioTrade Backend läuft auf Port ${PORT}`);
});
