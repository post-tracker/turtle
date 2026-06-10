const https = require( 'https' );
const url = require( 'url' );

const RSS = require( 'rss' );
const cron = require( 'node-cron' );

require( 'dotenv' ).config();

const upload = require( './r2' );
const buildAllSitemaps = require( './sitemap' );

if ( !process.env.API_TOKEN ) {
    throw new Error( 'Unable to load api key' );
}

if ( !process.env.AWS_ACCESS_KEY || !process.env.AWS_SECRET_KEY ) {
    throw new Error( 'AWS auth not configured' );
}

const API_HOST = 'api.developertracker.com';

const promiseGet = function promiseGet( requestUrl, headers = false ) {
    return new Promise( ( resolve, reject ) => {
        let httpsGet = requestUrl;
        if ( headers ) {
            const urlParts = url.parse( requestUrl );

            httpsGet = {
                headers: headers,
                hostname: urlParts.hostname,
                path: urlParts.path,
                port: urlParts.port || 443,
            };
        }

        console.log( `Loading ${ requestUrl }` );

        const request = https.get( httpsGet, ( response ) => {
            if ( response.statusCode < 200 || response.statusCode > 299 ) {
                reject( new Error( `Failed to load ${ requestUrl }, status code: ${ response.statusCode }` ) );
                request.destroy();

                return;
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
    const postsData = await promiseGet( `https://api.developertracker.com/${ game.identifier }/posts?excludeService=Twitter` );
    let posts;

    try {
        posts = JSON.parse( postsData );
    } catch ( parseFail ) {
        console.error( `Failed to parse posts for ${ game.identifier }` );
        throw parseFail;
    }

    // Games on the shared domain are served from www (the canonical public
    // host); the stored hostname is the bare apex, so map it across here.
    let siteUrl = game.hostname;

    if ( game.hostname === 'developertracker.com' ) {
        siteUrl = `www.developertracker.com/${ game.identifier }`;
    }

    const feed = new RSS( {
        title: `${ game.name } dev feed`,
        description: 'Feed with the latest posts from the developers',
        site_url: `https://${ siteUrl }/`,
        feed_url: `https://${ siteUrl }/rss/`,
        language: 'en-us',
        pubDate: new Date(),
        ttl: 10,
    } );

    const guidCache = [];

    for ( const post of posts.data ) {
        const formattedUrl = post.url.replace( '/&/g', '&amp;' );

        if ( guidCache.includes( formattedUrl ) ) {
            console.error( `Duplicate guid: ${ formattedUrl }` );
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

    await upload( `${ game.identifier }/rss`, feed.xml( { indent: true } ), 'application/rss+xml' );
    console.log( `Successfully uploaded rss for ${ game.identifier }` );
};

const run = async function run() {
    const games = await getGames();
    const results = await Promise.allSettled( games.map( ( game ) => {
        return buildRSS( game );
    } ) );

    const failures = results.filter( ( result ) => {
        return result.status === 'rejected';
    } );

    for ( const failure of failures ) {
        console.error( failure.reason );
    }

    return failures.length;
};

const SCHEDULE = process.env.RUN_SCHEDULE || '*/10 * * * *';

let running = false;

const tick = async function tick() {
    if ( running ) {
        console.log( 'Previous run still in progress, skipping' );

        return;
    }

    running = true;

    try {
        const failureCount = await run();

        if ( failureCount > 0 ) {
            console.error( `Run completed with ${ failureCount } failures` );
        }
    } catch ( fatalError ) {
        console.error( fatalError );
    } finally {
        running = false;
    }
};

cron.schedule( SCHEDULE, tick );

tick();

// Sitemaps are far heavier to build than RSS (they paginate every post of
// every game), so they run on their own, slower cron instead of the RSS cycle.
const SITEMAP_SCHEDULE = process.env.SITEMAP_SCHEDULE || '0 * * * *';

let sitemapRunning = false;

const sitemapTick = async function sitemapTick() {
    if ( sitemapRunning ) {
        console.log( 'Previous sitemap run still in progress, skipping' );

        return;
    }

    sitemapRunning = true;

    try {
        await buildAllSitemaps();
    } catch ( sitemapError ) {
        console.error( sitemapError );
    } finally {
        sitemapRunning = false;
    }
};

cron.schedule( SITEMAP_SCHEDULE, sitemapTick );

// Build once on startup so a freshly deployed container populates sitemaps
// immediately instead of waiting up to an hour for the first cron tick.
sitemapTick();
