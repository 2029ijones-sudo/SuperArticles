import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { SUPABASE_CONFIG } from '../supabase-config.js';

const supabase = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.serviceKey);

// Security middleware for serverless functions
const securityMiddleware = (req, res, next) => {
  // Helmet-like security headers
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Download-Options', 'noopen');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  // CSP Headers (your original CSP)
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; " +
    "img-src 'self' data: https:;"
  );
  
  next();
};

// Rate limiting for serverless
const rateLimitStore = new Map();

const limiter = (req, res, next) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const max = 100; // 100 requests per window
  const now = Date.now();
  const windowStart = now - windowMs;
  
  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, []);
  }
  
  const requests = rateLimitStore.get(ip).filter(time => time > windowStart);
  
  if (requests.length >= max) {
    res.status(429).json({ 
      error: 'Too many requests, please try again later' 
    });
    return;
  }
  
  requests.push(now);
  rateLimitStore.set(ip, requests);
  next();
};
// Generate 20 security codes
function generateSecurityCodes() {
  const codes = [];
  for (let i = 0; i < 20; i++) {
    codes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
  }
  return codes;
}

// Send email with security codes
async function sendSecurityCodes(email, codes) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  const codeList = codes.map((code, index) => 
    `${index + 1}. ${code}`
  ).join('\n');

  const mailOptions = {
    from: process.env.SMTP_FROM,
    to: email,
    subject: 'Your SuperArticles Security Codes',
    text: `Here are your 20 security codes. Keep them safe!\n\n${codeList}\n\nEach code can be used once. Codes expire in 30 days.\n\nIf you forget your codes, you can request new ones in 7 days.`,
    html: `
      <h2>SuperArticles Security Codes</h2>
      <p>Here are your 20 security codes. Keep them safe!</p>
      <pre>${codeList}</pre>
      <p><strong>Important:</strong></p>
      <ul>
        <li>Each code can be used once</li>
        <li>Codes expire in 30 days</li>
        <li>If you forget your codes, you can request new ones in 7 days</li>
      </ul>
    `
  };

  return transporter.sendMail(mailOptions);
}

// Generate JWT token
function generateToken(userId) {
  const payload = {
    userId,
    exp: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60) // 30 days
  };
  const token = crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update(JSON.stringify(payload))
    .digest('hex');
  return token;
}

// Main login/register endpoint
export default async function handler(req, res) {

  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, action, securityCode } = req.body;

  try {
    switch (action) {
      case 'register':
        await handleRegister(email, res);
        break;
      
      case 'login':
        await handleLogin(email, securityCode, res);
        break;
      
      case 'request-new-codes':
        await handleRequestNewCodes(email, res);
        break;
      
      default:
        res.status(400).json({ error: 'Invalid action' });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleRegister(email, res) {
  // Check if user exists
  const { data: existingUser } = await supabase
    .from('users')
    .select('id')
    .eq('email', email)
    .single();

  if (existingUser) {
    return res.status(400).json({ error: 'User already exists' });
  }

  // Generate security codes
  const securityCodes = generateSecurityCodes();
  
  // Create user
  const { data: user, error } = await supabase
    .from('users')
    .insert({
      email,
      security_codes: securityCodes,
      last_code_refresh: new Date().toISOString(),
      next_refresh_allowed: new Date().toISOString()
    })
    .select()
    .single();

  if (error) throw error;

  // Send codes via email
  await sendSecurityCodes(email, securityCodes);

  res.status(200).json({
    message: 'Registration successful. Check your email for security codes.',
    userId: user.id
  });
}

async function handleLogin(email, securityCode, res) {
  // Get user
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', email)
    .single();

  if (error || !user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Check if code is valid
  const codeIndex = user.security_codes.indexOf(securityCode);
  if (codeIndex === -1) {
    return res.status(401).json({ error: 'Invalid security code' });
  }

  // Remove used code
  const updatedCodes = [...user.security_codes];
  updatedCodes[codeIndex] = null; // Mark as used

  // Update user
  await supabase
    .from('users')
    .update({
      security_codes: updatedCodes,
      updated_at: new Date().toISOString()
    })
    .eq('id', user.id);

  // Generate token
  const token = generateToken(user.id);

  // Set HTTP-only cookie
  res.setHeader('Set-Cookie', [
    `token=${token}; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 24 * 60 * 60}; Path=/`,
    `user_id=${user.id}; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 24 * 60 * 60}; Path=/`
  ]);

  res.status(200).json({
    message: 'Login successful',
    codesRemaining: updatedCodes.filter(code => code !== null).length
  });
}

async function handleRequestNewCodes(email, res) {
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', email)
    .single();

  if (error || !user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Check if refresh is allowed
  const now = new Date();
  const nextRefresh = new Date(user.next_refresh_allowed);

  if (now < nextRefresh) {
    const daysLeft = Math.ceil((nextRefresh - now) / (1000 * 60 * 60 * 24));
    return res.status(429).json({
      error: `Please wait ${daysLeft} day(s) before requesting new codes`
    });
  }

  // Generate new codes
  const newCodes = generateSecurityCodes();

  // Update user with new codes
  await supabase
    .from('users')
    .update({
      security_codes: newCodes,
      last_code_refresh: now.toISOString(),
      next_refresh_allowed: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      updated_at: now.toISOString()
    })
    .eq('id', user.id);

  // Send new codes
  await sendSecurityCodes(email, newCodes);

  res.status(200).json({
    message: 'New security codes sent to your email. Next refresh allowed in 7 days.'
  });
}
