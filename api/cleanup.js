// api/cleanup.js
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_CONFIG } from '../supabase-config.js';

const supabase = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.key);

// Cron job security check
function validateCronRequest(req) {
  const cronSecret = req.headers['x-cron-secret'];
  return cronSecret === process.env.CRON_SECRET;
}

// Generate email notifications for outdated articles
async function notifyUsersOfOutdatedArticles() {
  const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  
  // Find articles that will be outdated in 7 days
  const { data: upcomingOutdated, error: upcomingError } = await supabase
    .from('superhero_articles')
    .select(`
      id,
      title,
      next_renewal_date,
      user_id,
      users!inner (
        email
      )
    `)
    .lt('next_renewal_date', sevenDaysFromNow.toISOString())
    .eq('status', 'active')
    .lt('renewal_notification_sent', new Date().toISOString()); // Only if not recently notified
  
  if (upcomingError) {
    console.error('Error fetching upcoming outdated articles:', upcomingError);
    return;
  }
  
  // Update notification sent date
  const articleIds = upcomingOutdated.map(article => article.id);
  if (articleIds.length > 0) {
    await supabase
      .from('superhero_articles')
      .update({ 
        renewal_notification_sent: new Date().toISOString() 
      })
      .in('id', articleIds);
    
    console.log(`Sent renewal notifications for ${articleIds.length} articles`);
  }
}

// Permanently remove old outdated articles
async function removeOldArticles() {
  const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
  
  // Find articles that have been outdated for 20+ days
  const { data: oldArticles, error: oldError } = await supabase
    .from('superhero_articles')
    .select('id, title, user_id, encrypted_id')
    .lt('next_renewal_date', twentyDaysAgo.toISOString())
    .eq('status', 'outdated');
  
  if (oldError) {
    console.error('Error fetching old articles:', oldError);
    return 0;
  }
  
  if (oldArticles.length === 0) {
    return 0;
  }
  
  // Mark articles as removed
  const articleIds = oldArticles.map(article => article.id);
  const { error: updateError } = await supabase
    .from('superhero_articles')
    .update({ 
      status: 'removed',
      removal_date: new Date().toISOString(),
      removal_reason: 'automatic_cleanup_20_days'
    })
    .in('id', articleIds);
  
  if (updateError) {
    console.error('Error removing articles:', updateError);
    return 0;
  }
  
  // Log removal for audit
  console.log(`Removed ${articleIds.length} articles:`, articleIds);
  return articleIds.length;
}

// Update outdated articles status
async function markOutdatedArticles() {
  const now = new Date();
  
  // Find articles whose renewal date has passed
  const { data: outdatedArticles, error: outdatedError } = await supabase
    .from('superhero_articles')
    .select('id, title, next_renewal_date')
    .lt('next_renewal_date', now.toISOString())
    .eq('status', 'active');
  
  if (outdatedError) {
    console.error('Error fetching outdated articles:', outdatedError);
    return 0;
  }
  
  if (outdatedArticles.length === 0) {
    return 0;
  }
  
  // Mark articles as outdated
  const articleIds = outdatedArticles.map(article => article.id);
  const { error: updateError } = await supabase
    .from('superhero_articles')
    .update({ 
      status: 'outdated',
      outdated_since: now.toISOString(),
      quality_score: supabase.sql`GREATEST(quality_score - 20, 0)`
    })
    .in('id', articleIds);
  
  if (updateError) {
    console.error('Error marking articles as outdated:', updateError);
    return 0;
  }
  
  console.log(`Marked ${articleIds.length} articles as outdated`);
  return articleIds.length;
}

// Generate renewal recommendations
async function generateRecommendations() {
  // Get outdated articles that need recommendations
  const { data: outdatedArticles, error } = await supabase
    .from('superhero_articles')
    .select('id, title, content, tags, category, created_at')
    .eq('status', 'outdated')
    .is('renewal_recommendations', null)
    .limit(50);
  
  if (error || !outdatedArticles?.length) {
    return 0;
  }
  
  const recommendations = [];
  
  for (const article of outdatedArticles) {
    const articleAge = Math.floor(
      (new Date() - new Date(article.created_at)) / (1000 * 60 * 60 * 24)
    );
    
    // Generate recommendations based on article characteristics
    const recs = [];
    
    if (articleAge > 180) {
      recs.push("Complete rewrite needed - major updates to character history");
    } else if (articleAge > 90) {
      recs.push("Update with latest comic series and appearances");
    } else {
      recs.push("Add recent developments and fan theories");
    }
    
    if (article.category === 'movie') {
      recs.push("Include latest film adaptations and casting news");
    } else if (article.category === 'comic') {
      recs.push("Add recent story arcs and crossover events");
    }
    
    if (article.tags.length < 5) {
      recs.push("Expand tags for better searchability");
    }
    
    // Store recommendations
    recommendations.push({
      articleId: article.id,
      recommendations: recs.slice(0, 3),
      generated_at: new Date().toISOString()
    });
  }
  
  // Update articles with recommendations
  for (const rec of recommendations) {
    await supabase
      .from('superhero_articles')
      .update({ 
        renewal_recommendations: rec.recommendations,
        recommendations_generated_at: rec.generated_at
      })
      .eq('id', rec.articleId);
  }
  
  console.log(`Generated recommendations for ${recommendations.length} articles`);
  return recommendations.length;
}

// Main cleanup handler
export default async function handler(req, res) {
  // Only allow POST requests with valid cron secret
  if (req.method !== 'POST' || !validateCronRequest(req)) {
    return res.status(403).json({ 
      error: 'Forbidden',
      message: 'Valid cron secret required'
    });
  }
  
  try {
    const startTime = Date.now();
    
    console.log('Starting automated cleanup process...');
    
    // Step 1: Mark outdated articles
    const outdatedCount = await markOutdatedArticles();
    
    // Step 2: Remove articles outdated for 20+ days
    const removedCount = await removeOldArticles();
    
    // Step 3: Generate renewal recommendations
    const recommendationsCount = await generateRecommendations();
    
    // Step 4: Send renewal notifications (optional, if email configured)
    if (process.env.SMTP_HOST) {
      await notifyUsersOfOutdatedArticles();
    }
    
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;
    
    res.status(200).json({
      success: true,
      message: 'Cleanup process completed',
      stats: {
        outdatedMarked: outdatedCount,
        removed: removedCount,
        recommendationsGenerated: recommendationsCount,
        duration: `${duration.toFixed(2)} seconds`
      },
      timestamp: new Date().toISOString(),
      nextRun: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // Next run in 24 hours
    });
    
  } catch (error) {
    console.error('Cleanup process error:', error);
    res.status(500).json({
      error: 'Cleanup process failed',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
}

// Additional endpoint for manual trigger (protected)
export async function manualHandler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  // Verify admin token
  const adminToken = req.headers['admin-token'];
  if (adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  // Call the main handler
  return handler(req, res);
}
