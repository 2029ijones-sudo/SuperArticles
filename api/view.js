// api/view.js
import { createClient } from '@supabase/supabase-js';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { SUPABASE_CONFIG } from '../supabase-config.js';

const supabase = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.key);

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
    
    // In production, use proper JWT verification
    // For now, we'll use a simplified check
    const expectedToken = require('crypto')
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
    // Check if user has already viewed this article today
    const today = new Date().toISOString().split('T')[0];
    const { data: existingView } = await supabase
      .from('article_views')
      .select('id')
      .eq('article_id', articleId)
      .eq('user_id', userId)
      .gte('viewed_at', `${today}T00:00:00Z`)
      .limit(1)
      .single();
    
    if (!existingView) {
      // Add view record
      await supabase
        .from('article_views')
        .insert({
          article_id: articleId,
          user_id: userId,
          viewed_at: new Date().toISOString()
        });
      
      // Update article view count
      await supabase.rpc('increment_views', { article_id: articleId });
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
    const { data: article, error } = await supabase
      .from('superhero_articles')
      .select(`
        *,
        users (
          id,
          email,
          username
        ),
        comments (
          id,
          content,
          created_at,
          user_id,
          users (
            username,
            avatar_url
          )
        ),
        bookmarks:article_bookmarks(count),
        likes:article_likes(count)
      `)
      .eq('encrypted_id', encryptedId)
      .eq('status', 'active')
      .single();
    
    if (error) throw error;
    
    // Format comments
    const formattedComments = article.comments?.map(comment => ({
      id: comment.id,
      content: comment.content,
      created_at: comment.created_at,
      author: {
        id: comment.user_id,
        username: comment.users?.username || 'Anonymous',
        avatar: comment.users?.avatar_url || `https://ui-avatars.com/api/?name=${comment.users?.username || 'User'}`
      }
    })) || [];
    
    // Parse content
    let content = {};
    try {
      content = typeof article.content === 'string' ? 
        JSON.parse(article.content) : article.content;
    } catch (e) {
      content = { text: article.content || '' };
    }
    
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
      author: {
        id: article.users?.id,
        username: article.users?.username || article.users?.email?.split('@')[0] || 'Anonymous',
        email: article.users?.email
      },
      stats: {
        views: article.views || 0,
        likes: article.likes?.[0]?.count || 0,
        bookmarks: article.bookmarks?.[0]?.count || 0,
        comments: article.comments?.length || 0
      },
      renewal: {
        lastRenewed: article.last_renewed,
        nextRenewal: article.next_renewal_date,
        daysLeft: Math.ceil((new Date(article.next_renewal_date) - new Date()) / (1000 * 60 * 60 * 24))
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

// Get user's interaction status (liked, bookmarked)
async function getUserInteractionStatus(articleId, userId) {
  try {
    const [likesResult, bookmarksResult] = await Promise.all([
      supabase
        .from('article_likes')
        .select('id')
        .eq('article_id', articleId)
        .eq('user_id', userId)
        .single(),
      
      supabase
        .from('article_bookmarks')
        .select('id')
        .eq('article_id', articleId)
        .eq('user_id', userId)
        .single()
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
      .single();
    
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
      .single();
    
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
      query = query.contains('tags', tags.slice(0, 3));
    } else if (category) {
      query = query.eq('category', category);
    }
    
    const { data: articles, error } = await query;
    
    if (error) throw error;
    
    return articles.map(article => ({
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
  securityMiddleware(req.app);
  
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    const { encryptedId, action } = req.query;
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.token;
    const userId = cookies.user_id;
    
    if (!encryptedId) {
      return res.status(400).json({ error: 'Article ID is required' });
    }
    
    // Get article
    const article = await getArticleByEncryptedId(encryptedId);
    
    if (!article) {
      return res.status(404).json({ error: 'Article not found or no longer available' });
    }
    
    // Authenticate user if token exists
    let user = null;
    if (token && userId) {
      user = await verifyUserToken(token, userId);
    }
    
    switch (action) {
      case 'view':
        // Increment view count if user is authenticated
        if (user) {
          await incrementViewCount(article.id, user.id);
        }
        return res.status(200).json({
          success: true,
          data: article
        });
        
      case 'comment':
        if (!user || req.method !== 'POST') {
          return res.status(401).json({ error: 'Authentication required' });
        }
        
        const { content } = req.body;
        if (!content || content.trim().length < 1) {
          return res.status(400).json({ error: 'Comment cannot be empty' });
        }
        
        const comment = await addComment(article.id, user.id, content);
        if (!comment) {
          return res.status(500).json({ error: 'Failed to add comment' });
        }
        
        return res.status(200).json({
          success: true,
          comment: comment
        });
        
      case 'like':
        if (!user || req.method !== 'POST') {
          return res.status(401).json({ error: 'Authentication required' });
        }
        
        const likeResult = await toggleLike(article.id, user.id);
        if (!likeResult) {
          return res.status(500).json({ error: 'Failed to update like' });
        }
        
        return res.status(200).json({
          success: true,
          liked: likeResult.liked
        });
        
      case 'bookmark':
        if (!user || req.method !== 'POST') {
          return res.status(401).json({ error: 'Authentication required' });
        }
        
        const bookmarkResult = await toggleBookmark(article.id, user.id);
        if (!bookmarkResult) {
          return res.status(500).json({ error: 'Failed to update bookmark' });
        }
        
        return res.status(200).json({
          success: true,
          bookmarked: bookmarkResult.bookmarked
        });
        
      case 'interactions':
        const interactions = user ? await getUserInteractionStatus(article.id, user.id) : 
          { liked: false, bookmarked: false };
        
        return res.status(200).json({
          success: true,
          interactions: interactions
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
        // Default: get article with interactions if user is logged in
        const interactionsData = user ? await getUserInteractionStatus(article.id, user.id) : 
          { liked: false, bookmarked: false };
        
        // Increment view count if user is authenticated
        if (user) {
          await incrementViewCount(article.id, user.id);
        }
        
        return res.status(200).json({
          success: true,
          data: {
            ...article,
            userInteractions: interactionsData
          }
        });
    }
    
  } catch (error) {
    console.error('View API error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}
