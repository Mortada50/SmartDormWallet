/**
 * @file cloudinary.js
 * @description Cloudinary SDK initialisation.
 *
 * ⚠️  SECURITY RULE (spec §7):
 *   Receipt URLs are NEVER stored as permanent public URLs.
 *   Store only the Cloudinary public_id. Generate a Signed URL server-side
 *   on each request using generateSignedUrl() below with a 15-minute TTL.
 *
 * Upload options:
 *  - Max file size enforcement is done at the API middleware layer (multer).
 *  - MIME type validation is done server-side in the upload middleware.
 *  - All uploaded assets are stored in organised folders by resource type.
 *
 * @module config/cloudinary
 */

'use strict';

const cloudinary = require('cloudinary').v2;
const env = require('./env');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// Initialise SDK once at module load time
// ---------------------------------------------------------------------------

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true, // always HTTPS URLs
});

logger.debug('[cloudinary] تم تهيئة Cloudinary SDK');

// ---------------------------------------------------------------------------
// Folder structure
// ---------------------------------------------------------------------------

/** Folder paths used when uploading assets. */
const FOLDERS = Object.freeze({
  DEPOSIT_RECEIPTS: 'smart-dorm-wallet/deposit-receipts',
  WITHDRAWAL_RECEIPTS: 'smart-dorm-wallet/withdrawal-receipts',
  EXPENSE_RECEIPTS: 'smart-dorm-wallet/expense-receipts',
  MERCHANT_SETTLEMENTS: 'smart-dorm-wallet/merchant-settlements',
  PROFILE_IMAGES: 'smart-dorm-wallet/profile-images',
});

// ---------------------------------------------------------------------------
// Signed URL generation
// ---------------------------------------------------------------------------

/**
 * Generates a short-lived (15 minutes) signed Cloudinary URL for a resource.
 *
 * Use this for:
 *  - Withdrawal receipt delivery to user (spec §7)
 *  - Any other sensitive document that must not be permanently public
 *
 * @param {string} publicId - The Cloudinary public_id stored in DB.
 * @param {object} [options={}] - Additional Cloudinary URL options.
 * @returns {string} A signed URL valid for exactly 15 minutes.
 */
function generateSignedUrl(publicId, options = {}) {
  const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60; // +15 min

  return cloudinary.url(publicId, {
    sign_url: true,
    expires_at: expiresAt,
    resource_type: 'image',
    type: 'upload',
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Upload helper
// ---------------------------------------------------------------------------

/**
 * Uploads a file buffer to Cloudinary.
 *
 * @param {Buffer} fileBuffer - Raw file data.
 * @param {object} uploadOptions - Cloudinary upload options.
 * @param {string} uploadOptions.folder - Target folder (use FOLDERS constants).
 * @param {string} [uploadOptions.public_id] - Optional explicit public_id.
 * @param {string} [uploadOptions.resource_type='image'] - Resource type.
 * @returns {Promise<{publicId: string, url: string, format: string, bytes: number}>}
 */
async function uploadFile(fileBuffer, uploadOptions) {
  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'image',
        ...uploadOptions,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    stream.end(fileBuffer);
  });

  return {
    publicId: result.public_id,
    format: result.format,
    bytes: result.bytes,
    width: result.width,
    height: result.height,
  };
}

/**
 * Deletes a resource from Cloudinary by its public_id.
 * Used when a deposit/withdrawal request is deleted before approval.
 *
 * @param {string} publicId - Cloudinary public_id.
 * @returns {Promise<void>}
 */
async function deleteFile(publicId) {
  await cloudinary.uploader.destroy(publicId);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  cloudinary,
  FOLDERS,
  generateSignedUrl,
  uploadFile,
  deleteFile,
};
