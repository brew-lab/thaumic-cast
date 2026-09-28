//! Rolls a window of samples up into the few numbers a log line carries.

/// Minimum, 10th percentile, maximum and mean of a window of samples.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowStats {
    /// Smallest sample.
    pub min: f64,
    /// 10th percentile (nearest rank): the level the window stayed above
    /// nine tenths of the time.
    pub p10: f64,
    /// Largest sample.
    pub max: f64,
    /// Mean of the samples.
    pub mean: f64,
}

impl WindowStats {
    /// Rolls up `samples`, or `None` if there are none. Reorders `samples`.
    pub fn of(samples: &mut [f64]) -> Option<Self> {
        if samples.is_empty() {
            return None;
        }
        samples.sort_unstable_by(f64::total_cmp);
        let n = samples.len();
        // Nearest rank: the smallest sample at or above 10% of the window.
        let rank = (n as f64 * 0.1).ceil().max(1.0) as usize;
        Some(Self {
            min: samples[0],
            p10: samples[rank - 1],
            max: samples[n - 1],
            mean: samples.iter().sum::<f64>() / n as f64,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_window_has_no_stats() {
        assert_eq!(WindowStats::of(&mut []), None);
    }

    #[test]
    fn a_window_rolls_up_to_min_p10_max_and_mean() {
        let mut samples: Vec<f64> = (1..=20).rev().map(f64::from).collect();
        let stats = WindowStats::of(&mut samples).unwrap();
        assert_eq!(stats.min, 1.0);
        assert_eq!(stats.p10, 2.0);
        assert_eq!(stats.max, 20.0);
        assert_eq!(stats.mean, 10.5);
    }

    #[test]
    fn a_single_sample_is_every_statistic() {
        let stats = WindowStats::of(&mut [19.0]).unwrap();
        assert_eq!(
            (stats.min, stats.p10, stats.max, stats.mean),
            (19.0, 19.0, 19.0, 19.0)
        );
    }
}
