use sqlx::PgPool;
use std::time::Duration;

/// Recalculate trending scores for all active songs.
///
/// Formula:
///   base = weighted_upvotes - weighted_downvotes
///        + log10(max(plays, 1)) * 2
///        + log10(max(tips_near, 0.01) + 1) * 9
///
///   Vote weights: voters with reputation <= 1.0 get weight * 0.5 (anti-spam)
///
///   Multipliers: newbie(×0.5), no-genre(×0.7), no-lyrics(×0.7/0.85), no-cover(×0.7)
///
///   effective_days = max((hours_age - 168) / 24, 0)   (no decay in first 7 days)
///   score = base × multipliers / (effective_days + 1)^0.5  (gradual fade)
pub async fn recalculate_feed_scores(pool: &PgPool) -> Result<(), sqlx::Error> {
    // One pass for both columns, writing only rows whose values changed: every
    // UPDATE rewrites the row and its index entries (score is indexed, so it
    // can't be HOT), and with ~1k songs every 5 minutes that was ~350k row
    // rewrites a day of pure WAL churn. `top_score` changes only on events
    // (votes, plays, tips, edits). `score` also decays with age, so it is kept
    // to 3 significant digits: an old song's value then moves every few hours
    // instead of every pass, and the feed order is unaffected.
    let result = sqlx::query(
        r#"
        UPDATE songs
        SET score = sub.new_score, top_score = sub.new_top
        FROM (
            SELECT
                b.id,
                b.base::FLOAT8 AS new_top,
                (CASE WHEN b.decayed = 0 THEN 0
                      ELSE ROUND(b.decayed, 2 - FLOOR(LOG(ABS(b.decayed)))::INT)
                 END)::FLOAT8 AS new_score
            FROM (
                SELECT
                    s.id,
                    base.v AS base,
                    base.v::NUMERIC / POWER(
                        GREATEST(EXTRACT(EPOCH FROM (NOW() - s.created_at)) / 3600.0 - 168, 0) / 24.0 + 1,
                        0.5
                    )::NUMERIC AS decayed
                FROM songs s
                JOIN users u ON u.id = s.uploader_id
                LEFT JOIN (
                    SELECT
                        v.song_id,
                        SUM(CASE WHEN v.value > 0
                            THEN v.value::NUMERIC * v.weight
                                 * CASE WHEN vu.reputation_score <= 1.0 THEN 0.5 ELSE 1.0 END
                            ELSE 0 END) AS weighted_upvotes,
                        SUM(CASE WHEN v.value < 0
                            THEN ABS(v.value::NUMERIC * v.weight)
                                 * CASE WHEN vu.reputation_score <= 1.0 THEN 0.5 ELSE 1.0 END
                            ELSE 0 END) AS weighted_downvotes
                    FROM votes v
                    JOIN users vu ON vu.id = v.user_id
                    GROUP BY v.song_id
                ) v_agg ON v_agg.song_id = s.id
                LEFT JOIN (
                    SELECT song_id, COUNT(*) * 7.0 AS diamond_weight
                    FROM diamond_likes GROUP BY song_id
                ) dl_agg ON dl_agg.song_id = s.id
                CROSS JOIN LATERAL (
                    SELECT (
                        COALESCE(v_agg.weighted_upvotes, 0)
                        + COALESCE(dl_agg.diamond_weight, 0)
                        - COALESCE(v_agg.weighted_downvotes, 0)
                        + LOG(GREATEST(s.play_count, 1)::NUMERIC) * 2
                        + LOG(GREATEST(CAST(s.total_tips_yocto AS NUMERIC) / 1e24, 0.01) + 1) * 9
                    )
                    * CASE
                        WHEN u.total_uploads < 3 AND u.reputation_score < 1.5 THEN 0.5
                        ELSE 1.0
                      END
                    * CASE WHEN NOT EXISTS (SELECT 1 FROM song_genres sg WHERE sg.song_id = s.id) THEN 0.7 ELSE 1.0 END
                    * CASE
                        WHEN s.lyrics IS NULL OR s.lyrics = '' THEN 0.7
                        WHEN LENGTH(s.lyrics) < 200 THEN 0.85
                        ELSE 1.0
                      END
                    * CASE WHEN s.cover_image_url IS NULL THEN 0.7 ELSE 1.0 END
                    AS v
                ) base
                WHERE s.is_deleted = FALSE
                  AND s.is_hidden = FALSE
            ) b
        ) sub
        WHERE songs.id = sub.id
          AND (songs.score IS DISTINCT FROM sub.new_score
               OR songs.top_score IS DISTINCT FROM sub.new_top)
        "#,
    )
    .execute(pool)
    .await?;

    tracing::info!("Feed scores recalculated: {} songs changed", result.rows_affected());

    Ok(())
}

/// Spawns a background loop that recalculates feed scores every 5 minutes.
pub async fn start_feed_scoring_loop(pool: PgPool) {
    let mut interval = tokio::time::interval(Duration::from_secs(5 * 60));

    loop {
        interval.tick().await;

        tracing::info!("Running feed score recalculation...");

        if let Err(e) = recalculate_feed_scores(&pool).await {
            tracing::error!("Feed score recalculation failed: {}", e);
        }
    }
}
