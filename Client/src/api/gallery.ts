import type { Attachment } from './types';
import { request } from './client';

export type GalleryCategory = 'images' | 'videos' | 'documents' | 'links';
export interface GalleryItem { id: string; messageId: string; authorName: string; createdAt: string; attachment?: Attachment; links?: string[] }
export interface GalleryPage { items: GalleryItem[]; nextCursor: string | null }
export const galleryApi = {
  list(channelId: string, category: GalleryCategory, cursor?: string, signal?: AbortSignal): Promise<GalleryPage> {
    return request(`/api/v1/channels/${channelId}/gallery`, { query: { category, cursor, limit: 24 }, signal });
  },
};
