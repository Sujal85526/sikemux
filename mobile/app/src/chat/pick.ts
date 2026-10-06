import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import type { Attachment } from './session';

/** A photo is sent no larger than this on its longest side, which agents read at full detail. */
const LONGEST_EDGE = 2048;
/** Pictures the transcript can draw from this phone; others are sent as files. */
const DRAWN = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

let picks = 0;
const nextId = () => `pick-${(picks += 1)}`;

function stem(name: string | null | undefined): string | undefined {
  return name?.replace(/\.[^.]*$/, '') || undefined;
}

function sizeOf(uri: string): number {
  return new File(uri).size ?? 0;
}

/** From the photo library, scaled down and as JPEG, which every agent reads (HEIC included). */
export async function pickPhotos(limit: number): Promise<Attachment[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: limit,
    quality: 1,
    exif: false,
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  });
  if (result.canceled) return [];
  const photos: Attachment[] = [];
  // One at a time, since each full-size photo is decoded in memory.
  for (const asset of result.assets.slice(0, limit)) photos.push(await asJpeg(asset));
  return photos;
}

async function asJpeg(asset: ImagePicker.ImagePickerAsset): Promise<Attachment> {
  const context = ImageManipulator.manipulate(asset.uri);
  if (Math.max(asset.width, asset.height) > LONGEST_EDGE) {
    context.resize(asset.width >= asset.height ? { width: LONGEST_EDGE } : { height: LONGEST_EDGE });
  }
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
  image.release();
  context.release();
  return {
    id: nextId(),
    kind: 'image',
    name: `${stem(asset.fileName) ?? 'photo'}.jpg`,
    mime: 'image/jpeg',
    uri: saved.uri,
    size: sizeOf(saved.uri),
  };
}

export async function pickFiles(limit: number): Promise<Attachment[]> {
  const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: true });
  if (result.canceled) return [];
  return result.assets.slice(0, limit).map((asset) => {
    const mime = asset.mimeType ?? 'application/octet-stream';
    return {
      id: nextId(),
      kind: DRAWN.has(mime) ? 'image' : 'file',
      name: asset.name,
      mime,
      uri: asset.uri,
      size: asset.size ?? sizeOf(asset.uri),
    };
  });
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
