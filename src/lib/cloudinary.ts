import { v2 as cloudinary } from "cloudinary";
import { Readable } from "node:stream";
import { env } from "../config/env.js";

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
});

export interface CloudinaryUploadResult {
  url: string;
  publicId: string;
}

export async function uploadImageBuffer(
  buffer: Buffer,
  folder: string = "macho-halisi/itineraries"
): Promise<CloudinaryUploadResult> {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "image",
      },
      (error, result) => {
        if (error || !result) {
          return reject(error || new Error("Cloudinary upload returned an empty result"));
        }
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
        });
      }
    );

    Readable.from(buffer).pipe(uploadStream);
  });
}

export async function deleteCloudinaryAsset(publicId: string): Promise<any> {
  return cloudinary.uploader.destroy(publicId, { resource_type: "image" });
}

export { cloudinary };
