import supabase from './supabase.js';

// ---------------------------------------------------------------------------
// This bot is the FULL coin-distribution channel until the official Meta
// WhatsApp Cloud API webhook (app/api/whatsapp/webhook/route.ts) is linked.
// Every balance read/write here goes through the site's real tables
// (public.user_wallets / public.coin_transactions) and its existing RPCs
// from supabase/migrations/0006_product_catalog_wallets.sql
// (award_coins, claim_packet_coins, claim_box_coins, redeem_payout) plus
// get_or_create_wallet / coin_transactions.type additions from 0010 — so
// there is exactly ONE coin balance per phone number, no matter which
// WhatsApp integration answers a given message.
//
// IMPORTANT: this module NEVER sends a message on its own initiative. It
// only ever returns a string reply in response to an inbound message that
// server.js hands it — nothing here schedules, broadcasts, or pushes a
// message out of band. Every code path below returns a string; nothing
// throws past handleMessage().
// ---------------------------------------------------------------------------

const SIGNUP_BONUS = 50;
const DAILY_BONUS = 10;
const QR_CLAIM_BONUS = 50;
const QUIZ_COIN_PER_ANSWER = 5;
const QUIZ_JACKPOT_BONUS = 20;
const DAILY_COOLDOWN_HOURS = 24;
const PAYOUT_COINS = 25000;
const PAYOUT_AMOUNT_INR = 250.0;

const QUIZ_QUESTIONS = [
  {
    q: '1️⃣ *What is the capital of India?*\nA) Mumbai\nB) New Delhi\nC) Kolkata\nD) Chennai',
    answer: 'B',
  },
  {
    q: '2️⃣ *Which gas do plants absorb from the air for photosynthesis?*\nA) Oxygen\nB) Nitrogen\nC) Carbon Dioxide\nD) Hydrogen',
    answer: 'C',
  },
  {
    q: '3️⃣ *How many continents are there on Earth?*\nA) 5\nB) 6\nC) 7\nD) 8',
    answer: 'C',
  },
  {
    q: '4️⃣ *What is the chemical formula for water?*\nA) H2O\nB) O2\nC) CO2\nD) NaCl',
    answer: 'A',
  },
  {
    q: '5️⃣ *Who wrote the Indian National Anthem?*\nA) Mahatma Gandhi\nB) Rabindranath Tagore\nC) Bankim Chandra Chattopadhyay\nD) Sarojini Naidu',
    answer: 'B',
  },
];

// ---------------------------------------------------------------------------
// Wallet helpers — all against public.user_wallets, never a separate table.
// ---------------------------------------------------------------------------
async function getOrCreateWallet(phone, name = null) {
  const { data, error } = await supabase.rpc('get_or_create_wallet', {
    p_phone: phone,
    p_name: name,
  });
  if (error) throw error;
  return data;
}

async function getBalance(phone) {
  const { data, error } = await supabase
    .from('user_wallets')
    .select('coin_balance')
    .eq('phone', phone)
    .single();
  if (error) throw error;
  return data.coin_balance;
}

// award_coins() returns the ledger row, not the new balance — fetch balance
// after, matching what claim_packet_coins()/claim_box_coins() already do.
async function awardCoins(phone, amount, type, packetCode = null, metadata = {}) {
  const { error } = await supabase.rpc('award_coins', {
    p_phone: phone,
    p_amount: amount,
    p_type: type,
    p_packet_code: packetCode,
    p_metadata: metadata,
  });
  if (error) throw error;
  return getBalance(phone);
}

async function markSignupBonusClaimed(phone) {
  const { error } = await supabase
    .from('user_wallets')
    .update({ signup_bonus_claimed: true })
    .eq('phone', phone);
  if (error) throw error;
}

async function updateLastDaily(phone) {
  const { error } = await supabase
    .from('user_wallets')
    .update({ last_daily_at: new Date().toISOString() })
    .eq('phone', phone);
  if (error) throw error;
}

async function setQuizState(phone, quizState) {
  const { error } = await supabase
    .from('user_wallets')
    .update({ quiz_state: quizState })
    .eq('phone', phone);
  if (error) throw error;
}

async function clearQuizState(phone) {
  await setQuizState(phone, null);
}

// ---------------------------------------------------------------------------
// Dashboard-QR <-> WhatsApp linking: "verify_<uuid>"
// ---------------------------------------------------------------------------
async function handleQrVerification(phone, text) {
  const uuid = text.split('_')[1]?.trim();

  if (!uuid) {
    return '❌ Invalid QR payload. Please scan the QR code again.';
  }

  const { data: session, error } = await supabase
    .from('qr_verifications')
    .select('*')
    .eq('verification_uuid', uuid)
    .eq('status', 'pending')
    .maybeSingle();

  if (error || !session) {
    return '❌ *Invalid or Expired QR Code!*\nPlease refresh the product screen to get a new QR.';
  }

  if (new Date(session.expires_at).getTime() < Date.now()) {
    await supabase
      .from('qr_verifications')
      .update({ status: 'expired' })
      .eq('verification_uuid', uuid);
    return '⌛ *QR Code Expired!*\nPlease refresh your browser.';
  }

  await supabase
    .from('qr_verifications')
    .update({ status: 'verified', whatsapp_phone: phone })
    .eq('verification_uuid', uuid);

  await getOrCreateWallet(phone);

  // Link the wallet to the logged-in website account that generated the QR.
  if (session.profile_id) {
    await supabase
      .from('user_wallets')
      .update({ linked_profile_id: session.profile_id })
      .eq('phone', phone);
  }

  const newBalance = await awardCoins(
    phone,
    QR_CLAIM_BONUS,
    'qr_claim',
    uuid,
    { verification_uuid: uuid }
  );

  return (
    `✅ *Authentication Successful!*\n\n` +
    `🔗 WhatsApp linked with Product Dashboard.\n` +
    `🎉 *+${QR_CLAIM_BONUS} Coins* credited!\n` +
    `💰 Balance: *${newBalance} coins*\n\n` +
    `${helpText()}`
  );
}

// ---------------------------------------------------------------------------
// Packet / box scan claims — same commands the official webhook supports,
// now live here too since this bot is the active channel for now.
// ---------------------------------------------------------------------------
async function handlePacketClaim(phone, text, profileName) {
  const coinCode = text.trim();
  const { data, error } = await supabase.rpc('claim_packet_coins', {
    p_phone: phone,
    p_coin_code: coinCode,
    p_name: profileName,
    p_referral_code: null,
  });

  if (error) {
    console.error('claim_packet_coins error:', error);
    return "❌ Couldn't process that claim right now — please try again shortly.";
  }

  const result = data?.[0];
  if (!result) return "❌ Couldn't process that claim right now — please try again shortly.";

  return result.ok
    ? `✅ ${result.message}\n+${result.coins_awarded} coins earned.\n💰 Balance: ${result.new_balance} coins.`
    : `❌ ${result.message}`;
}

async function handleBoxClaim(phone, text, profileName) {
  const boxSerial = text.replace(/^CLAIMBOX-/i, 'KOKO-BOX-').trim();
  const { data, error } = await supabase.rpc('claim_box_coins', {
    p_phone: phone,
    p_box_serial: boxSerial,
    p_name: profileName,
  });

  if (error) {
    console.error('claim_box_coins error:', error);
    return "❌ Couldn't process that box claim right now — please try again shortly.";
  }

  const result = data?.[0];
  if (!result) return "❌ Couldn't process that box claim right now — please try again shortly.";

  return result.ok
    ? `✅ ${result.message}\n+${result.coins_awarded} coins earned.\n💰 Balance: ${result.new_balance} coins.`
    : `❌ ${result.message}`;
}

async function handleReferral(phone) {
  const { data: wallet, error } = await supabase
    .from('user_wallets')
    .select('referral_code')
    .eq('phone', phone)
    .maybeSingle();

  if (error) {
    console.error('referral lookup error:', error);
    return "❌ Couldn't fetch your referral code right now — please try again shortly.";
  }

  if (!wallet) {
    return "You don't have a koko wallet yet — say *hi* to get started! 🍿";
  }

  return (
    `🤝 Your referral code: *${wallet.referral_code}*\n` +
    `Share it with friends — you earn 25 coins when their first scan is linked to your code.`
  );
}

async function handlePayout(phone, text) {
  const upiId = text.replace(/^!?payout/i, '').trim();

  if (!upiId || !upiId.includes('@')) {
    return 'Please send your UPI ID like this: *!payout yourname@upi*';
  }

  const { data, error } = await supabase.rpc('redeem_payout', {
    p_phone: phone,
    p_upi_id: upiId,
    p_coins: PAYOUT_COINS,
    p_amount_inr: PAYOUT_AMOUNT_INR,
  });

  if (error) {
    console.error('redeem_payout error:', error);
    return "❌ Couldn't process that payout right now — please try again shortly.";
  }

  const result = data?.[0];
  return result?.ok ? `✅ ${result.message}` : `❌ ${result?.message ?? 'Payout request failed.'}`;
}

// ---------------------------------------------------------------------------
// Builders & Handlers
// ---------------------------------------------------------------------------
function helpText() {
  return (
    `🤖 *Commands*\n` +
    `• *CLAIM-<code>* — scan the QR inside your packet for coins\n` +
    `• *CLAIMBOX-<serial>* — B2B/retailer bulk box claim\n` +
    `• *!balance* — check coin balance\n` +
    `• *!daily* — claim daily +${DAILY_BONUS} coins\n` +
    `• *!refer* — get your referral code to share\n` +
    `• *!payout <upi-id>* — redeem ${PAYOUT_COINS} coins for ₹${PAYOUT_AMOUNT_INR}\n` +
    `• *!quiz* — play 5-question quiz (+${QUIZ_COIN_PER_ANSWER} coins/correct)\n` +
    `• *!cancel* — exit ongoing quiz`
  );
}

async function handleGreeting(wallet, phone) {
  if (!wallet.signup_bonus_claimed) {
    const newBalance = await awardCoins(phone, SIGNUP_BONUS, 'signup_bonus', null, {});
    await markSignupBonusClaimed(phone);
    return (
      `👋 Welcome to Koko Coins!\n` +
      `🎉 You've received *+${SIGNUP_BONUS} coins* as a signup bonus.\n` +
      `💰 Balance: *${newBalance} coins*\n\n${helpText()}`
    );
  }

  const balance = await getBalance(phone);
  return `👋 Hi again!\n💰 Balance: *${balance} coins*\n\n${helpText()}`;
}

async function handleDailyCheckin(wallet, phone) {
  const now = Date.now();
  const last = wallet.last_daily_at ? new Date(wallet.last_daily_at).getTime() : 0;
  const hoursSince = (now - last) / (1000 * 60 * 60);

  if (hoursSince < DAILY_COOLDOWN_HOURS) {
    const hoursLeft = Math.ceil(DAILY_COOLDOWN_HOURS - hoursSince);
    return `⏳ You've already checked in today.\nCome back in *${hoursLeft}h* for your next +${DAILY_BONUS} coins.`;
  }

  const newBalance = await awardCoins(phone, DAILY_BONUS, 'daily_checkin', null, {});
  await updateLastDaily(phone);
  return `✅ Daily check-in successful!\n🎉 +${DAILY_BONUS} coins added.\n💰 Balance: *${newBalance} coins*`;
}

async function startQuiz(phone) {
  const state = { index: 0, score: 0 };
  await setQuizState(phone, state);
  return (
    `🧠 Quiz started! Reply with *A*, *B*, *C* or *D*.\n` +
    `Earn +${QUIZ_COIN_PER_ANSWER} coins per correct answer.\n\n${QUIZ_QUESTIONS[0].q}`
  );
}

async function handleQuizAnswer(wallet, phone, rawText) {
  const state = wallet.quiz_state || { index: 0, score: 0 };
  const current = QUIZ_QUESTIONS[state.index];
  const answer = rawText.trim().toUpperCase().charAt(0);

  if (!['A', 'B', 'C', 'D'].includes(answer)) {
    return `❓ Please reply with A, B, C or D.\n\n${current.q}`;
  }

  let feedback;
  let balance = await getBalance(phone);

  if (answer === current.answer) {
    balance = await awardCoins(phone, QUIZ_COIN_PER_ANSWER, 'quiz_correct', null, { question: state.index + 1 });
    state.score += 1;
    feedback = `✅ Correct! +${QUIZ_COIN_PER_ANSWER} coins`;
  } else {
    feedback = `❌ Wrong! Correct answer was *${current.answer}*.`;
  }

  state.index += 1;

  if (state.index >= QUIZ_QUESTIONS.length) {
    if (state.score === QUIZ_QUESTIONS.length) {
      balance = await awardCoins(phone, QUIZ_JACKPOT_BONUS, 'quiz_jackpot', null, {});
      feedback += `\n🏆 *Jackpot Bonus:* +${QUIZ_JACKPOT_BONUS} extra coins!`;
    }

    await clearQuizState(phone);
    return (
      `${feedback}\n\n🏁 Quiz complete! Score: *${state.score}/${QUIZ_QUESTIONS.length}*\n` +
      `💰 Balance: *${balance} coins*\n\n${helpText()}`
    );
  }

  await setQuizState(phone, state);
  return `${feedback}\n\n${QUIZ_QUESTIONS[state.index].q}`;
}

// ---------------------------------------------------------------------------
// Main Dispatcher
// ---------------------------------------------------------------------------
async function handleMessageInternal(phone, rawText, profileName = null) {
  const text = (rawText || '').trim();
  const lower = text.toLowerCase();
  const upper = text.toUpperCase();

  // QR Handshake Trigger (dashboard link, not a packet/box claim)
  if (lower.startsWith('verify_') || lower.startsWith('verify ')) {
    const formatted = text.replace('verify ', 'verify_');
    return await handleQrVerification(phone, formatted);
  }

  // Packet coin claim: "CLAIM-<code>" (but not "CLAIMBOX-...")
  if (upper.startsWith('CLAIM-') && !upper.startsWith('CLAIMBOX-')) {
    await getOrCreateWallet(phone, profileName);
    return handlePacketClaim(phone, text, profileName);
  }

  // Box coin claim (B2B/retail partner): "CLAIMBOX-<serial>"
  if (upper.startsWith('CLAIMBOX-')) {
    await getOrCreateWallet(phone, profileName);
    return handleBoxClaim(phone, text, profileName);
  }

  const wallet = await getOrCreateWallet(phone, profileName);

  if (lower === '!cancel' || lower === '!exit') {
    if (wallet.quiz_state) {
      await clearQuizState(phone);
      return `🛑 Quiz cancelled.\n\n${helpText()}`;
    }
    return `ℹ️ No active quiz running.\n\n${helpText()}`;
  }

  if (wallet.quiz_state && lower !== '!quiz') {
    return handleQuizAnswer(wallet, phone, text);
  }

  if (['hi', 'hello', 'hey', 'start'].includes(lower)) {
    return handleGreeting(wallet, phone);
  }

  switch (true) {
    case lower === '!balance' || lower === '!coins' || upper === 'BALANCE' || upper === 'BAL': {
      const balance = await getBalance(phone);
      return `💰 Your balance: *${balance} coins*`;
    }
    case lower === '!daily':
      return handleDailyCheckin(wallet, phone);
    case lower === '!quiz':
      return startQuiz(phone);
    case lower === '!refer' || upper === 'REFER' || upper === 'REFERRAL':
      return handleReferral(phone);
    case lower.startsWith('!payout') || upper.startsWith('PAYOUT'):
      return handlePayout(phone, text);
    default:
      return `🤔 Sorry, I didn't understand that.\n\n${helpText()}`;
  }
}

// ---------------------------------------------------------------------------
// Public entry point — wraps handleMessageInternal in a catch-all so an
// unexpected DB/RPC error (missing function, bad param, RLS block, etc.)
// still ALWAYS sends the user some reply instead of silently failing —
// this is what was broken: a thrown error here used to reach server.js's
// catch block, which only logged it and sent nothing back to WhatsApp.
// The real error is logged here for debugging in Render logs.
//
// This function only ever returns a reply string for the inbound message
// it was called with — it never calls sock.sendMessage or any send API
// itself, and never initiates contact with anyone on its own.
// ---------------------------------------------------------------------------
export async function handleMessage(phone, rawText, profileName = null) {
  try {
    return await handleMessageInternal(phone, rawText, profileName);
  } catch (err) {
    console.error('❌ handleMessage fatal error:', err);
    return "⚠️ Kuch technical dikkat aa gayi hai, thodi der baad dobara try karo. Agar dikkat rahe toh 'hi' bhejkar dekho.";
  }
}
