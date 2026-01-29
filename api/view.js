// api/view.js
import { createClient } from '@supabase/supabase-js';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { SUPABASE_CONFIG } from '../supabase-config.js';

const supabase = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.serviceKey);

// Allowed origins
const allowedOrigins = [
  'https://super-articles2-dw6dzdreu-duede.vercel.app',
  'https://super-articles2.vercel.app',
  'http://localhost:3000',
  'http://localhost:5000'
];

// Security middleware
const securityMiddleware = (app) => {
  app.use(helmet({
    contentSecurityPolicy: false // Disable for API responses
  }));
  
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
  });
  app.use('/api/view', limiter);
};

// Set CORS headers middleware
const corsMiddleware = (req, res, next) => {
  const origin = req.headers.origin;
  
  // Check if origin is allowed
  if (allowedOrigins.includes(origin) || !origin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  } else {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigins[0]);
  }
  
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  next();
};

// Parse cookies
function parseCookies(cookieHeader) {
  const cookies = {};
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      if (name && value) {
        cookies[name] = decodeURIComponent(value);
      }
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
    
    // Simple token verification
    // In production, use proper JWT verification
    const crypto = await import('crypto');
    const expectedToken = crypto
      .createHmac('sha256', process.env.JWT_SECRET || 'default-secret')
      .update(JSON.stringify({ userId: user.id }))
      .digest('hex');
    
    return token === expectedToken ? user : null;
  } catch (error) {
    console.error('Token verification error:', error);
    return null;
  }
}

// Increment view count
async function incrementViewCount(articleId, userId) {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Check if user has already viewed today
    const { data: existingView, error: viewError } = await supabase
      .from('article_views')
      .select('id')
      .eq('article_id', articleId)
      .eq('user_id', userId)
      .gte('viewed_at', `${today}T00:00:00Z`)
      .lt('viewed_at', `${today}T23:59:59Z`)
      .maybeSingle();
    
    if (viewError && viewError.code !== 'PGRST116') {
      console.error('Error checking existing view:', viewError);
    }
    
    // Only increment if not viewed today
    if (!existingView) {
      // Add view record
      const { error: insertError } = await supabase
        .from('article_views')
        .insert({
          article_id: articleId,
          user_id: userId,
          viewed_at: new Date().toISOString()
        });
      
      if (insertError) {
        console.error('Error inserting view:', insertError);
      } else {
        // Update article view count
        const { error: rpcError } = await supabase.rpc('increment_views', { 
          article_id: articleId 
        });
        
        if (rpcError) {
          console.error('Error incrementing views RPC:', rpcError);
          // Fallback: manual update
          const { data: article } = await supabase
            .from('superhero_articles')
            .select('views')
            .eq('id', articleId)
            .single();
          
          if (article) {
            await supabase
              .from('superhero_articles')
              .update({ views: (article.views || 0) + 1 })
              .eq('id', articleId);
          }
        }
      }
    }
    
    return true;
  } catch (error) {
    console.error('Error incrementing view count:', error);
    return false;
  }
}

// Get article by encrypted ID
async function getArticleByEncryptedId(encryptedId) {
  try {
    console.log('Fetching article with encryptedId:', encryptedId);
    
    const { data: article, error } = await supabase
      .from('superhero_articles')
      .select(`
        *,
        users!inner (
          id,
          email,
          username
        )
      `)
      .eq('encrypted_id', encryptedId)
      .eq('status', 'active')
      .single();
    
    if (error) {
      console.error('Supabase error fetching article:', error);
      return null;
    }
    
    if (!article) {
      console.log('No article found with encryptedId:', encryptedId);
      return null;
    }
    
    // Get comments
    const { data: comments, error: commentsError } = await supabase
      .from('comments')
      .select(`
        *,
        users (
          username,
          avatar_url
        )
      `)
      .eq('article_id', article.id)
      .order('created_at', { ascending: false });
    
    // Get likes count
    const { count: likesCount, error: likesError } = await supabase
      .from('article_likes')
      .select('*', { count: 'exact', head: true })
      .eq('article_id', article.id);
    
    // Get bookmarks count
    const { count: bookmarksCount, error: bookmarksError } = await supabase
      .from('article_bookmarks')
      .select('*', { count: 'exact', head: true })
      .eq('article_id', article.id);
    
    // Parse content
    let content = {};
    try {
      content = typeof article.content === 'string' ? 
        JSON.parse(article.content) : article.content;
      
      // Handle double-encoded JSON
      if (typeof content === 'string') {
        content = JSON.parse(content);
      }
    } catch (e) {
      console.error('Error parsing article content:', e);
      content = { text: article.content || '' };
    }
    
    // Format comments
    const formattedComments = (comments || []).map(comment => ({
      id: comment.id,
      content: comment.content,
      created_at: comment.created_at,
      author: {
        id: comment.user_id,
        username: comment.users?.username || 'Anonymous',
        avatar: comment.users?.avatar_url || `https://ui-avatars.com/api/?name=${comment.users?.username || 'User'}`
      }
    }));
    
    // Calculate days left for renewal
    const nextRenewal = new Date(article.next_renewal_date);
    const now = new Date();
    const daysLeft = Math.ceil((nextRenewal - now) / (1000 * 60 * 60 * 24));
    
    return {
      id: article.id,
      encryptedId: article.encrypted_id,
      title: article.title,
      pageName: article.page_name,
      content: content,
      imageUrl: article.image_url,
      vercelUrl: article.vercel_url,
      tags: article.tags || [],
      category: article.category,
      description: article.description,
      author: {
        id: article.users?.id,
        username: article.users?.username || article.users?.email?.split('@')[0] || 'Anonymous',
        email: article.users?.email
      },
      stats: {
        views: article.views || 0,
        likes: likesCount || 0,
        bookmarks: bookmarksCount || 0,
        comments: formattedComments.length || 0
      },
      renewal: {
        lastRenewed: article.last_renewed,
        nextRenewal: article.next_renewal_date,
        daysLeft: Math.max(0, daysLeft)
      },
      metadata: {
        created: article.created_at,
        updated: article.updated_at,
        qualityScore: article.quality_score || 100,
        status: article.status
      },
      comments: formattedComments,
      recommendations: article.renewal_recommendations || []
    };
  } catch (error) {
    console.error('Error fetching article:', error);
    return null;
  }
}

// Get user's interaction status
async function getUserInteractionStatus(articleId, userId) {
  try {
    const [likesResult, bookmarksResult] = await Promise.all([
      supabase
        .from('article_likes')
        .select('id')
        .eq('article_id', articleId)
        .eq('user_id', userId)
        .maybeSingle(),
      
      supabase
        .from('article_bookmarks')
        .select('id')
        .eq('article_id', articleId)
        .eq('user_id', userId)
        .maybeSingle()
    ]);
    
    return {
      liked: !!likesResult.data,
      bookmarked: !!bookmarksResult.data
    };
  } catch (error) {
    console.error('Error getting user interactions:', error);
    return { liked: false, bookmarked: false };
  }
}

// Add comment
async function addComment(articleId, userId, content) {
  try {
    const { data: comment, error } = await supabase
      .from('comments')
      .insert({
        article_id: articleId,
        user_id: userId,
        content: content.trim(),
        created_at: new Date().toISOString()
      })
      .select(`
        *,
        users (
          username,
          avatar_url
        )
      `)
      .single();
    
    if (error) throw error;
    
    return {
      id: comment.id,
      content: comment.content,
      created_at: comment.created_at,
      author: {
        id: comment.user_id,
        username: comment.users?.username || 'Anonymous',
        avatar: comment.users?.avatar_url || `https://ui-avatars.com/api/?name=${comment.users?.username || 'User'}`
      }
    };
  } catch (error) {
    console.error('Error adding comment:', error);
    return null;
  }
}

// Toggle like
async function toggleLike(articleId, userId) {
  try {
    // Check if already liked
    const { data: existingLike } = await supabase
      .from('article_likes')
      .select('id')
      .eq('article_id', articleId)
      .eq('user_id', userId)
      .maybeSingle();
    
    if (existingLike) {
      // Unlike
      await supabase
        .from('article_likes')
        .delete()
        .eq('id', existingLike.id);
      
      // Decrement like count
      await supabase.rpc('decrement_likes', { article_id: articleId });
      
      return { liked: false };
    } else {
      // Like
      await supabase
        .from('article_likes')
        .insert({
          article_id: articleId,
          user_id: userId,
          created_at: new Date().toISOString()
        });
      
      // Increment like count
      await supabase.rpc('increment_likes', { article_id: articleId });
      
      return { liked: true };
    }
  } catch (error) {
    console.error('Error toggling like:', error);
    return null;
  }
}

// Toggle bookmark
async function toggleBookmark(articleId, userId) {
  try {
    // Check if already bookmarked
    const { data: existingBookmark } = await supabase
      .from('article_bookmarks')
      .select('id')
      .eq('article_id', articleId)
      .eq('user_id', userId)
      .maybeSingle();
    
    if (existingBookmark) {
      // Remove bookmark
      await supabase
        .from('article_bookmarks')
        .delete()
        .eq('id', existingBookmark.id);
      
      return { bookmarked: false };
    } else {
      // Add bookmark
      await supabase
        .from('article_bookmarks')
        .insert({
          article_id: articleId,
          user_id: userId,
          created_at: new Date().toISOString()
        });
      
      return { bookmarked: true };
    }
  } catch (error) {
    console.error('Error toggling bookmark:', error);
    return null;
  }
}

// Get related articles
async function getRelatedArticles(articleId, tags = [], category = '', limit = 3) {
  try {
    let query = supabase
      .from('superhero_articles')
      .select('*')
      .neq('id', articleId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(limit);
    
    // If tags exist, find articles with similar tags
    if (tags && tags.length > 0) {
      query = query.overlaps('tags', tags.slice(0, 3));
    } else if (category) {
      query = query.eq('category', category);
    }
    
    const { data: articles, error } = await query;
    
    if (error) throw error;
    
    return (articles || []).map(article => ({
      id: article.id,
      title: article.title,
      pageName: article.page_name,
      imageUrl: article.image_url,
      vercelUrl: article.vercel_url,
      excerpt: article.excerpt || article.title,
      tags: article.tags || [],
      category: article.category,
      views: article.views || 0,
      created: article.created_at
    }));
  } catch (error) {
    console.error('Error fetching related articles:', error);
    return [];
  }
}

export default async function handler(req, res) {
  // Apply CORS middleware first
  corsMiddleware(req, res, async () => {
    try {
      const { encryptedId, action } = req.query;
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies.token;
      const userId = cookies.user_id;
      
      console.log('API Request:', { 
        encryptedId, 
        action, 
        method: req.method,
        origin: req.headers.origin,
        hasToken: !!token,
        hasUserId: !!userId 
      });
      
      if (!encryptedId) {
        return res.status(400).json({ 
          success: false,
          error: 'Article ID is required' 
        });
      }
      
      // Get article
      const article = await getArticleByEncryptedId(encryptedId);
      
      if (!article) {
        return res.status(404).json({ 
          success: false,
          error: 'Article not found or no longer available' 
        });
      }
      
      // Authenticate user if token exists
      let user = null;
      if (token && userId) {
        user = await verifyUserToken(token, userId);
      }
      
      // Handle different actions
      switch (action) {
        case 'view':
          // Increment view count if user is authenticated
          if (user) {
            await incrementViewCount(article.id, user.id);
          } else {
            // Increment anonymous view
            await supabase.rpc('increment_views', { article_id: article.id });
          }
          
          const interactions = user ? await getUserInteractionStatus(article.id, user.id) : 
            { liked: false, bookmarked: false };
          
          return res.status(200).json({
            success: true,
            data: {
              ...article,
              userInteractions: interactions
            }
          });
          
        case 'comment':
          if (!user || req.method !== 'POST') {
            return res.status(401).json({ 
              success: false,
              error: 'Authentication required' 
            });
          }
          
          const { content } = req.body;
          if (!content || content.trim().length < 1) {
            return res.status(400).json({ 
              success: false,
              error: 'Comment cannot be empty' 
            });
          }
          
          const comment = await addComment(article.id, user.id, content);
          if (!comment) {
            return res.status(500).json({ 
              success: false,
              error: 'Failed to add comment' 
            });
          }
          
          return res.status(200).json({
            success: true,
            comment: comment
          });
          
        case 'like':
          if (!user || req.method !== 'POST') {
            return res.status(401).json({ 
              success: false,
              error: 'Authentication required' 
            });
          }
          
          const likeResult = await toggleLike(article.id, user.id);
          if (!likeResult) {
            return res.status(500).json({ 
              success: false,
              error: 'Failed to update like' 
            });
          }
          
          return res.status(200).json({
            success: true,
            liked: likeResult.liked
          });
          
        case 'bookmark':
          if (!user || req.method !== 'POST') {
            return res.status(401).json({ 
              success: false,
              error: 'Authentication required' 
            });
          }
          
          const bookmarkResult = await toggleBookmark(article.id, user.id);
          if (!bookmarkResult) {
            return res.status(500).json({ 
              success: false,
              error: 'Failed to update bookmark' 
            });
          }
          
          return res.status(200).json({
            success: true,
            bookmarked: bookmarkResult.bookmarked
          });
          
        case 'interactions':
          const interactionsStatus = user ? await getUserInteractionStatus(article.id, user.id) : 
            { liked: false, bookmarked: false };
          
          return res.status(200).json({
            success: true,
            interactions: interactionsStatus
          });
          
        case 'related':
          const related = await getRelatedArticles(
            article.id, 
            article.tags, 
            article.category, 
            3
          );
          
          return res.status(200).json({
            success: true,
            articles: related
          });
          
        default:
          // Default: get article with interactions
          const defaultInteractions = user ? await getUserInteractionStatus(article.id, user.id) : 
            { liked: false, bookmarked: false };
          
          // Increment view count (authenticated or anonymous)
          if (user) {
            await incrementViewCount(article.id, user.id);
          } else {
            // Update view count for anonymous users
            await supabase
              .from('superhero_articles')
              .update({ views: (article.stats.views || 0) + 1 })
              .eq('id', article.id);
          }
          
          return res.status(200).json({
            success: true,
            data: {
              ...article,
              userInteractions: defaultInteractions
            }
          });
      }
      
    } catch (error) {
      console.error('View API error:', error);
      res.status(500).json({ 
        success: false,
        error: 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });
}
