const https = require( 'https' );
const url = require( 'url' );

const RSS = require( 'rss' );
const AWS = require( 'aws-sdk' );

require( 'dotenv' ).config();

if ( !process.env.API_TOKEN ) {
    throw new Error( 'Unable to load api key' );
}

if ( !process.env.AWS_ACCESS_KEY || !process.env.AWS_SECRET_KEY ) {
    throw new Error( 'AWS auth not configured' );
}

const API_HOST = 'api.kokarn.com';
const S3_BUCKET = 'developer-tracker';

const s3 = new AWS.S3( {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_KEY,
} );

const promiseGet = function promiseGet( requestUrl, headers = false ) {
    return new Promise( ( resolve, reject ) => {
        let httpsGet = requestUrl;
        if ( headers ) {
            const urlParts = url.parse( requestUrl );

            httpsGet = {
                headers: headers,
                hostname: urlParts.hostname,
                path: urlParts.path,
                port: urlParts.port || 443,
            };
        }

        console.log( `Loading ${ requestUrl }` );

        const request = https.get( httpsGet, ( response ) => {
            if ( response.statusCode < 200 || response.statusCode > 299 ) {
                reject( new Error( `Failed to load ${ requestUrl }, status code: ${ response.statusCode }` ) );
            }

            const body = [];

            console.log( `Done with ${ requestUrl }` );

            response.on( 'data', ( chunk ) => {
                body.push( chunk );
            } );

            response.on( 'end', () => {
                resolve( body.join( '' ) );
            } );
        } );

        request.on( 'error', ( requestError ) => {
            reject( requestError );
        } );
    } );
};

const getGames = async function getGames() {
    let allGamesConfig;
    const gamesConfig = {};

    try {
        const gamesConfigResponse = await promiseGet( `https://${ API_HOST }/games`, {
            Authorization: `Bearer ${ process.env.API_TOKEN }`,
        } );
        allGamesConfig = JSON.parse( gamesConfigResponse );
    } catch ( getGamesError ) {
        console.log( `Unable to load games. Got "${ getGamesError.message }"` );

        throw getGamesError;
    }

    return allGamesConfig.data;
};

const buildRSS = async function buildRSS( game ){
    const postsData = await promiseGet( `https://api.developertracker.com/${ game.identifier }/posts?excludeService=Twitter` );
    let posts;

    try {
        posts = JSON.parse( postsData );
    } catch ( parseFail ) {
        console.error( `Failed to parse posts for ${ game.identifier }` );
        throw parseFail;
    }

    let siteUrl = game.hostname;

    if ( game.hostname === 'developertracker.com' ) {
        siteUrl = `${ siteUrl }/${ game.identifier }/`;
    }

    const feed = new RSS( {
        title: `${ game.name } dev feed`,
        description: 'Feed with the latest posts from the developers',
        site_url: `https://${ siteUrl }`,
        feed_url: `https://${ siteUrl }/rss/`,
        language: 'en-us',
        pubDate: new Date(),
        ttl: 10,
    } );

    const guidCache = [];

    for ( const post of posts.data ) {
        const formattedUrl = post.url.replace( '/&/g', '&amp;' );

        if ( guidCache.includes( formattedUrl ) ) {
            console.error( `Duplicate guid: ${ formattedUrl }` );
            continue;
        } else {
            guidCache.push( formattedUrl );
        }

        feed.item( {
            title: post.topic,
            description: post.content,
            url: formattedUrl,
            date: new Date( post.timestamp * 1000 ),
            author: post.account.developer.nick || post.account.developer.name,
            categories: [ post.account.service ],
        } );
    }

    const params = {
        Bucket: S3_BUCKET,
        Key: `${ game.identifier }/rss`,
        Body: feed.xml( { indent: true } ),
        CacheControl: 'public, max-age=600',
        ContentType: 'application/rss+xml',
    };

    s3.putObject( params, ( uploadError, data ) => {
        if ( uploadError ) {
            console.error( uploadError )
        } else {
            console.log( `Successfully uploaded rss for ${ game.identifier }` );
        }
    } );
};

getGames()
    .then( ( games ) => {
        for ( const game of games ) {
            buildRSS( game );
        }
    } )
    .catch( ( someError ) => {
        console.error( someError );
    } );
