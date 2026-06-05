const AWS = require( 'aws-sdk' );

const S3_BUCKET = 'developer-tracker';
const R2_BUCKET = process.env.R2_BUCKET || 'developer-tracker';
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '66766e138fce1ac1d2ef95953e037f4e';

// Region is pinned to the bucket's real region. Without it the SDK defaults to
// us-east-1, discovers the bucket is in eu-west-1 via a redirect, and caches
// that in a bucket-name-keyed cache that is shared across S3 client instances —
// which then forces the R2 client (same bucket name) to sign for eu-west-1, a
// region R2 rejects. Pinning it here means no discovery, no shared-cache leak.
const s3 = new AWS.S3( {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_KEY,
    region: 'eu-west-1',
} );

// R2 is optional: if its credentials are absent we keep writing to S3 only, so
// deploying this code before the R2 token exists doesn't break the live feeds.
const r2Configured = Boolean( process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY );

const r2 = r2Configured ? new AWS.S3( {
    endpoint: `https://${ R2_ACCOUNT_ID }.r2.cloudflarestorage.com`,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    signatureVersion: 'v4',
    s3ForcePathStyle: true,
    region: 'auto',
} ) : null;

if ( !r2Configured ) {
    console.log( 'R2 credentials not set, uploading to S3 only' );
}

// Writes to S3 (required) and R2 (if configured). S3 errors propagate (current
// behaviour); R2 errors are logged but non-fatal so R2 never breaks S3 delivery.
module.exports = async function upload( key, body, contentType, cacheControl = 'public, max-age=600' ) {
    await s3.putObject( {
        Bucket: S3_BUCKET,
        Key: key,
        Body: body,
        CacheControl: cacheControl,
        ContentType: contentType,
    } ).promise();

    if ( r2 ) {
        try {
            await r2.putObject( {
                Bucket: R2_BUCKET,
                Key: key,
                Body: body,
                CacheControl: cacheControl,
                ContentType: contentType,
            } ).promise();
        } catch ( r2Error ) {
            console.error( `R2 upload failed for ${ key }: ${ r2Error.message }` );
        }
    }

    return key;
};
