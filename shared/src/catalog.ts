import type { MediaItem } from './types';

/**
 * Built-in catalog. Every title is an openly licensed Blender Foundation film
 * or a Google sample clip, so the project ships with nothing that needs
 * licensing. Swap `src` for your own HLS/MP4 URLs (must send CORS-friendly
 * range responses) to use your own library.
 */
const G = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample';

export const CATALOG: MediaItem[] = [
  {
    id: 'big-buck-bunny',
    title: 'Big Buck Bunny',
    year: 2008,
    categories: ['Animation', 'Comedy', 'Family'],
    durationSec: 596,
    description: 'A gentle giant rabbit gets even with three bullying rodents.',
    src: `${G}/BigBuckBunny.mp4`,
    rating: 7.2,
    tint: ['#3b7d3a', '#d9b44a'],
  },
  {
    id: 'sintel',
    title: 'Sintel',
    year: 2010,
    categories: ['Animation', 'Fantasy', 'Adventure'],
    durationSec: 888,
    description: 'A lone warrior searches the world for the baby dragon she lost.',
    src: `${G}/Sintel.mp4`,
    rating: 7.5,
    tint: ['#5a2d6d', '#e0743a'],
  },
  {
    id: 'tears-of-steel',
    title: 'Tears of Steel',
    year: 2012,
    categories: ['Sci-Fi', 'Action'],
    durationSec: 734,
    description: 'Fighters try to save the world from killer robots in a ruined Amsterdam.',
    src: `${G}/TearsOfSteel.mp4`,
    rating: 6.4,
    tint: ['#17324d', '#4aa3c9'],
  },
  {
    id: 'elephants-dream',
    title: "Elephant's Dream",
    year: 2006,
    categories: ['Animation', 'Sci-Fi', 'Surreal'],
    durationSec: 653,
    description: 'Two strangers wander an impossible machine that reality forgot.',
    src: `${G}/ElephantsDream.mp4`,
    rating: 6.1,
    tint: ['#6b2c2c', '#c9a14a'],
  },
  {
    id: 'for-bigger-blazes',
    title: 'For Bigger Blazes',
    year: 2013,
    categories: ['Short', 'Action'],
    durationSec: 15,
    description: 'A fifteen-second burst of heat. Perfect for testing seeks.',
    src: `${G}/ForBiggerBlazes.mp4`,
    rating: 5.0,
    tint: ['#7a1f10', '#f2a33a'],
  },
  {
    id: 'for-bigger-escapes',
    title: 'For Bigger Escapes',
    year: 2013,
    categories: ['Short', 'Adventure'],
    durationSec: 15,
    description: 'A quick getaway in fifteen seconds flat.',
    src: `${G}/ForBiggerEscapes.mp4`,
    rating: 5.1,
    tint: ['#1c4a5a', '#e8d5a2'],
  },
  {
    id: 'for-bigger-fun',
    title: 'For Bigger Fun',
    year: 2013,
    categories: ['Short', 'Comedy'],
    durationSec: 60,
    description: 'One minute of pure play.',
    src: `${G}/ForBiggerFun.mp4`,
    rating: 5.3,
    tint: ['#b0306a', '#f5c24a'],
  },
  {
    id: 'for-bigger-joyrides',
    title: 'For Bigger Joyrides',
    year: 2013,
    categories: ['Short', 'Adventure'],
    durationSec: 15,
    description: 'Wind, road and a very short trip.',
    src: `${G}/ForBiggerJoyrides.mp4`,
    rating: 5.2,
    tint: ['#2a5d8a', '#f0e08a'],
  },
  {
    id: 'for-bigger-meltdowns',
    title: 'For Bigger Meltdowns',
    year: 2013,
    categories: ['Short', 'Comedy'],
    durationSec: 15,
    description: 'Everything goes wrong, quickly.',
    src: `${G}/ForBiggerMeltdowns.mp4`,
    rating: 4.9,
    tint: ['#4a2a6a', '#d96a6a'],
  },
  {
    id: 'subaru-outback',
    title: 'Subaru Outback: Street & Dirt',
    year: 2012,
    categories: ['Lifestyle', 'Cars'],
    durationSec: 594,
    description: 'An all-wheel-drive wagon takes on tarmac and trail.',
    src: `${G}/SubaruOutbackOnStreetAndDirt.mp4`,
    rating: 5.8,
    tint: ['#2f4a2a', '#c8b27a'],
  },
  {
    id: 'vw-gti-review',
    title: 'Volkswagen GTI Review',
    year: 2012,
    categories: ['Lifestyle', 'Cars'],
    durationSec: 584,
    description: 'A hot-hatch road test, start to finish.',
    src: `${G}/VolkswagenGTIReview.mp4`,
    rating: 5.9,
    tint: ['#222a38', '#b23a3a'],
  },
  {
    id: 'bullrun',
    title: 'We Are Going on Bullrun',
    year: 2012,
    categories: ['Lifestyle', 'Adventure', 'Cars'],
    durationSec: 47,
    description: 'A rally convoy rolls out. Short and loud.',
    src: `${G}/WeAreGoingOnBullrun.mp4`,
    rating: 5.4,
    tint: ['#5a3a12', '#e6c35a'],
  },
  {
    id: 'what-car-for-a-grand',
    title: 'What Car Can You Get for a Grand?',
    year: 2012,
    categories: ['Lifestyle', 'Comedy', 'Cars'],
    durationSec: 44,
    description: 'A budget challenge in under a minute.',
    src: `${G}/WhatCarCanYouGetForAGrand.mp4`,
    rating: 5.2,
    tint: ['#3a3a3a', '#9ac26a'],
  },
];

export const CATEGORIES: string[] = [...new Set(CATALOG.flatMap((m) => m.categories))].sort();

const BY_ID = new Map(CATALOG.map((m) => [m.id, m]));
export function getMedia(id: string): MediaItem | undefined {
  return BY_ID.get(id);
}
