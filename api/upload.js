// api/upload.js
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
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
  
  // CSP Headers
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
  const max = 50; // 50 requests per window
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

// Generate encrypted article ID
function generateEncryptedId(pageName, userId) {
  const timestamp = Date.now();
  const data = `${pageName}-${userId}-${timestamp}`;
  return crypto
    .createHash('sha256')
    .update(data + process.env.ENCRYPTION_SECRET)
    .digest('hex')
    .substring(0, 20);
}

// Validate image URL
function isValidImageUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && 
           /\.(png|jpg|jpeg|webp|gif)$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

// Parse cookies
function parseCookies(cookieHeader) {
  const cookies = {};
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      cookies[name] = decodeURIComponent(value);
    });
  }
  return cookies;
}

// Verify user token
async function verifyUserToken(token, userId) {
  try {
    // Verify token matches user (simplified - in production use proper JWT)
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, security_codes')
      .eq('id', userId)
      .single();
    
    if (error || !user) return null;
    
    // Simple token verification (in production, use JWT library)
    const expectedToken = crypto
      .createHmac('sha256', process.env.JWT_SECRET)
      .update(JSON.stringify({ userId: user.id }))
      .digest('hex');
    
    return token === expectedToken ? user : null;
  } catch (error) {
    console.error('Token verification error:', error);
    return null;
  }
}

export default async function handler(req, res) {
  // Apply security middleware
  securityMiddleware(req, res, () => {
    // Apply rate limiting
    limiter(req, res, async () => {
      
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
      }

      try {
        // Authenticate user
        const cookies = parseCookies(req.headers.cookie);
        const token = cookies.token;
        const userId = cookies.user_id;
        
        if (!token || !userId) {
          return res.status(401).json({ error: 'Authentication required' });
        }
        
        const user = await verifyUserToken(token, userId);
        if (!user) {
          return res.status(401).json({ error: 'Invalid authentication' });
        }

        const { title, pageName, content, imageUrl, tags, category } = req.body;
        
        // Validation
        if (!title || !pageName || !content || !imageUrl) {
          return res.status(400).json({ error: 'Missing required fields' });
        }
        
        // Validate page name format
        const pageNameRegex = /^[a-z0-9-]{3,50}$/;
        if (!pageNameRegex.test(pageName)) {
          return res.status(400).json({ 
            error: 'Page name must be 3-50 lowercase letters, numbers, and hyphens only' 
          });
        }
        
        // Validate image URL
        if (!isValidImageUrl(imageUrl)) {
          return res.status(400).json({ 
            error: 'Invalid image URL. Must be HTTPS and end with .png, .jpg, .jpeg, .webp, or .gif' 
          });
        }
        
        // Check if page name already exists
        const { data: existingPage } = await supabase
          .from('superhero_articles')
          .select('id')
          .eq('page_name', pageName)
          .neq('status', 'removed')
          .single();
        
        if (existingPage) {
          return res.status(400).json({ error: 'Page name already exists' });
        }
        
        // Generate encrypted ID and Vercel URL
        const encryptedId = generateEncryptedId(pageName, user.id);
        const baseUrl = process.env.VERCEL_URL || 'https://superarticles.vercel.app';
        const vercelUrl = `${baseUrl}/${encryptedId}`;
        
        // Calculate renewal dates
        const now = new Date();
        const renewalDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        
        // Insert article into database
        const { data: article, error: insertError } = await supabase
          .from('superhero_articles')
          .insert({
            user_id: user.id,
            title: title.trim(),
            page_name: pageName,
            content: JSON.stringify({
              text: content,
              formatted: content, // For immersive display
              created: now.toISOString()
            }),
            image_url: imageUrl,
            vercel_url: vercelUrl,
            encrypted_id: encryptedId,
            tags: Array.isArray(tags) ? tags.slice(0, 10) : [],
            category: category || 'general',
            status: 'active',
            last_renewed: now.toISOString(),
            next_renewal_date: renewalDate.toISOString(),
            removal_date: new Date(renewalDate.getTime() + 20 * 24 * 60 * 60 * 1000).toISOString(),
            views: 0,
            quality_score: 100 // Initial quality score
          })
          .select()
          .single();
        
        if (insertError) {
          console.error('Database insert error:', insertError);
          return res.status(500).json({ error: 'Failed to create article' });
        }
        
        // Generate article recommendations (simplified)
        const recommendations = [
          "Add more character background details",
          "Include recent comic appearances",
          "Add power scale comparison",
          "Include creator interviews"
        ];
        
        res.status(200).json({
          success: true,
          message: 'SuperArticle created successfully!',
          data: {
            id: article.id,
            title: article.title,
            pageName: article.page_name,
            vercelUrl: article.vercel_url,
            encryptedId: article.encrypted_id,
            renewalDate: article.next_renewal_date,
            recommendations: recommendations,
            previewUrl: `${baseUrl}/preview/${encryptedId}`
          }
        });
        
      } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ 
          error: 'Internal server error',
          details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
      }
    });
  });
}
