import {
  clampGalleryIndex,
  galleryIndexFromOffset,
  gallerySwipeTarget,
  normalizeProductGalleryImages,
} from '../../src/utils/productGallery';

describe('product image gallery', () => {
  it('keeps every valid backend image in order and removes duplicates', () => {
    expect(normalizeProductGalleryImages({
      images: [
        { url: 'https://cdn.example.com/one.jpg' },
        'https://cdn.example.com/two.jpg',
        { url: 'https://cdn.example.com/one.jpg' },
        { url: 'not-a-url' },
      ],
    })).toEqual([
      { url: 'https://cdn.example.com/one.jpg' },
      { url: 'https://cdn.example.com/two.jpg' },
    ]);
  });

  it('falls back to the primary image or a stable placeholder page', () => {
    expect(normalizeProductGalleryImages({ image: 'https://cdn.example.com/main.jpg' }))
      .toEqual([{ url: 'https://cdn.example.com/main.jpg' }]);
    expect(normalizeProductGalleryImages({ images: [{ url: 'invalid' }] }))
      .toEqual([{ url: null }]);
  });

  it('derives and clamps the paging indicator from the actual page width', () => {
    expect(galleryIndexFromOffset(720, 360, 4)).toBe(2);
    expect(galleryIndexFromOffset(9999, 360, 4)).toBe(3);
    expect(clampGalleryIndex(-4, 4)).toBe(0);
  });

  it('moves exactly one image for deliberate swipes and settles short drags', () => {
    const base = { currentIndex: 1, imageCount: 4, galleryWidth: 360 };
    expect(gallerySwipeTarget({ ...base, translationX: -80 })).toBe(2);
    expect(gallerySwipeTarget({ ...base, translationX: 80 })).toBe(0);
    expect(gallerySwipeTarget({ ...base, translationX: -5, velocityX: -800 })).toBe(2);
    expect(gallerySwipeTarget({ ...base, translationX: 12, velocityX: 0 })).toBe(1);
  });

  it('never swipes past the first or last image', () => {
    expect(gallerySwipeTarget({ currentIndex: 0, imageCount: 3, translationX: 100, galleryWidth: 360 })).toBe(0);
    expect(gallerySwipeTarget({ currentIndex: 2, imageCount: 3, translationX: -100, galleryWidth: 360 })).toBe(2);
  });
});
