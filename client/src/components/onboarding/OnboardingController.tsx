'use client';

import React, { useState } from 'react';
import { usePathname } from 'next/navigation';
import { SpotlightOverlay, SpotlightStep } from './SpotlightOverlay';
import { apiClient } from '@/lib/api-client';
import { useSession } from '@/providers/SessionProvider';

const ONBOARDING_STEPS: SpotlightStep[] = [
  {
    target: 'retailer-brand',
    title: 'Pick a retailer & brand',
    description: 'Select which retailer and brand you want to scrape product data from. This determines which site the scraper will visit.',
  },
  {
    target: 'run-now',
    title: 'Start a job',
    description: 'Click Run Now to kick off a scraping job immediately. The scraper will discover products and extract all variant data.',
  },
  {
    target: 'schedule',
    title: 'Or schedule it',
    description: 'Set up automated recurring scrapes on specific days and times. Great for keeping your product data fresh on a regular cadence.',
  },
];

export const OnboardingController: React.FC = () => {
  const pathname = usePathname();
  const { session, refresh } = useSession();
  const [dismissed, setDismissed] = useState(false);
  const user = session?.user;

  const shouldShow =
    !dismissed &&
    pathname === '/jobs/create' &&
    user?.role === 'user' &&
    user.has_completed_onboarding === false;

  // The session is cached; refresh it so has_completed_onboarding is current
  // the next time anything reads it.
  const handleDone = () => {
    setDismissed(true);
    apiClient.completeOnboarding().then(() => refresh()).catch(() => {});
  };

  if (!shouldShow) return null;

  return (
    <SpotlightOverlay
      steps={ONBOARDING_STEPS}
      onComplete={handleDone}
      onSkip={handleDone}
    />
  );
};
