// api/renew.js
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { SUPABASE_CONFIG } from '../supabase-config.js';

const supabase = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.key);

// Security middleware
const securityMiddleware = (app) => {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"]
      }
    }
  }));
  
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30
  });
  app.use('/api/renew', limiter);
};

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
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email')
      .eq('id', userId)
      .single();
    
    if (error || !user) return null;
    
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

// Generate AI-powered renewal suggestions
function generateRenewalSuggestions(articleData) {
  const suggestions = [];
  const now = new Date();
  const articleAge = Math.floor((now - new Date(articleData.created_at)) / (1000 * 60 * 60 * 24));
  
  if (articleAge > 60) {
    suggestions.push("Update with recent comic series appearances");
    suggestions.push("Add new character developments from latest issues");
  }
  
  if (articleAge > 90) {
    suggestions.push("Include new movie/TV adaptations");
    suggestions.push("Update power rankings based on recent events");
  }
  
  // Check content length
  const contentLength = JSON.parse(articleData.content).text.length;
  if (contentLength < 1000) {
    suggestions.push("Expand article with more detailed backstory");
  }
  
  if (articleData.tags.length < 3) {
    suggestions.push("Add more relevant tags for better discovery");
  }
  
  // Add random general suggestions
  const generalSuggestions = [
    "Add creator interview quotes",
    "Include fan art showcase",
    "Add timeline of significant events",
    "Include power comparison charts",
    "Add merchandise recommendations",
    "Include cosplay guide",
    "Add reading order for comics",
    "Include voice actor information for animations"
  ];
  
  const randomSuggestion = generalSuggestions[
    Math.floor(Math.random() * generalSuggestions.length)
  ];
  if (!suggestions.includes(randomSuggestion)) {
    suggestions.push(randomSuggestion);
  }
  
  return suggestions.slice(0, 5); // Return top 5 suggestions
}

export default async function handler(req, res) {
  securityMiddleware(req.app);
  
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

    const { articleId, updatedContent, renewAll = false } = req.body;
    
    if (renewAll) {
      // Renew all user's articles that are active or outdated
      const { data: articles, error: fetchError } = await supabase
        .from('superhero_articles')
        .select('*')
        .eq('user_id', user.id)
        .in('status', ['active', 'outdated']);
      
      if (fetchError) {
        console.error('Fetch articles error:', fetchError);
        return res.status(500).json({ error: 'Failed to fetch articles' });
      }
      
      const renewalPromises = articles.map(async (article) => {
        const now = new Date();
        const renewalDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        const removalDate = new Date(renewalDate.getTime() + 20 * 24 * 60 * 60 * 1000);
        
        return supabase
          .from('superhero_articles')
          .update({
            status: 'active',
            last_renewed: now.toISOString(),
            next_renewal_date: renewalDate.toISOString(),
            removal_date: removalDate.toISOString(),
            quality_score: Math.min(article.quality_score + 10, 100),
            updated_at: now.toISOString()
          })
          .eq('id', article.id);
      });
      
      await Promise.all(renewalPromises);
      
      res.status(200).json({
        success: true,
        message: `Successfully renewed ${articles.length} articles`,
        renewedCount: articles.length
      });
      
    } else {
      // Renew specific article
      if (!articleId) {
        return res.status(400).json({ error: 'Article ID is required' });
      }
      
      // Get article data
      const { data: article, error: articleError } = await supabase
        .from('superhero_articles')
        .select('*')
        .eq('id', articleId)
        .eq('user_id', user.id)
        .single();
      
      if (articleError || !article) {
        return res.status(404).json({ error: 'Article not found or unauthorized' });
      }
      
      // Check if article can be renewed (not removed)
      if (article.status === 'removed') {
        return res.status(400).json({ error: 'Cannot renew removed article' });
      }
      
      const now = new Date();
      const renewalDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const removalDate = new Date(renewalDate.getTime() + 20 * 24 * 60 * 60 * 1000);
      
      // Prepare update data
      const updateData = {
        status: 'active',
        last_renewed: now.toISOString(),
        next_renewal_date: renewalDate.toISOString(),
        removal_date: removalDate.toISOString(),
        quality_score: Math.min(article.quality_score + 10, 100),
        updated_at: now.toISOString()
      };
      
      // If updated content provided, merge with existing content
      if (updatedContent) {
        const currentContent = JSON.parse(article.content);
        updateData.content = JSON.stringify({
          ...currentContent,
          text: updatedContent,
          lastUpdated: now.toISOString(),
          updateCount: (currentContent.updateCount || 0) + 1
        });
      }
      
      // Update article
      const { error: updateError } = await supabase
        .from('superhero_articles')
        .update(updateData)
        .eq('id', articleId);
      
      if (updateError) {
        console.error('Renewal update error:', updateError);
        return res.status(500).json({ error: 'Failed to renew article' });
      }
      
      // Generate new suggestions for next renewal
      const suggestions = generateRenewalSuggestions(article);
      
      res.status(200).json({
        success: true,
        message: 'Article renewed successfully!',
        data: {
          nextRenewalDate: renewalDate.toISOString(),
          removalDate: removalDate.toISOString(),
          suggestions: suggestions,
          status: 'active',
          qualityScore: updateData.quality_score
        }
      });
    }
    
  } catch (error) {
    console.error('Renew error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}
