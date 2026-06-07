const fs = require('node:fs');

const pLimit = require('p-limit');

require( 'dotenv' ).config();

const upload = require( './r2' );

const limit = pLimit(5);

const POSTS_PER_REQUEST = 1000;

if ( !process.env.API_TOKEN ) {
    throw new Error( 'Unable to load api key' );
}

if ( !process.env.AWS_ACCESS_KEY || !process.env.AWS_SECRET_KEY ) {
    throw new Error( 'AWS auth not configured' );
}

const API_HOST = 'api.developertracker.com';

const sitemapTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

function shuffle(array) {
    let currentIndex = array.length,  randomIndex;

    // While there remain elements to shuffle.
    while (currentIndex != 0) {

        // Pick a remaining element.
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;

        // And swap it with the current element.
        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
    }

    return array;
};

const addPath = (sitemap, url, changefreq = 'hourly') => {
    return `${sitemap}
    <url>
        <loc>https://developertracker.com${url}</loc>
        <changefreq>${changefreq}</changefreq>
    </url>`;
};

const uploadXML = async (filename) => {
    try {
        await upload( filename, fs.readFileSync(`./sitemap/${filename}`, 'utf-8'), 'application/xml' );
        console.log( `Successfully uploaded sitemap ${filename}` );
    } catch ( uploadError ) {
        console.error( uploadError );
    }
}

const getGames = async function getGames() {
    let allGamesConfig;

    try {
        const gamesConfigResponse = await fetch( `https://${ API_HOST }/games`, {
            Authorization: `Bearer ${ process.env.API_TOKEN }`,
        } );
        allGamesConfig = await gamesConfigResponse.json();
    } catch ( getGamesError ) {
        console.log( `Unable to load games. Got "${ getGamesError.message }"` );

        throw getGamesError;
    }

    return allGamesConfig.data;
};

const buildSitemap = async function buildSitemap(sitemap, gameIdentifier, offset = 0){
    console.log(`Loading ${POSTS_PER_REQUEST} posts for ${gameIdentifier} with offset ${offset}`);
    let posts;

    try {
        const postsDataResponse = await fetch( `https://${API_HOST}/${ gameIdentifier }/posts?limit=${POSTS_PER_REQUEST}&offset=${offset}` );
        posts = await postsDataResponse.json();
    } catch ( parseFail ) {
        console.error( `Failed to load posts for ${ gameIdentifier } at offset ${ offset }` );

        // Keep whatever we've collected rather than failing the whole run.
        return sitemap;
    }

    // The API caps offset (MAX_POST_OFFSET) and answers an over-cap request with
    // an error object, not a list. fetch() doesn't throw on a 4xx, so guard the
    // shape here: a non-array means "no more pages" — stop recursing instead of
    // crashing on posts.data being undefined (which used to fail the entire run
    // for any game larger than the offset cap).
    if ( !posts || !Array.isArray( posts.data ) ) {
        return sitemap;
    }

    for ( const post of posts.data ) {
        sitemap = addPath(sitemap, `/${ gameIdentifier }/?post=${post.id}`, 'never');
    }

    if(posts.data.length >= POSTS_PER_REQUEST){
        sitemap = await buildSitemap(sitemap, gameIdentifier, offset + POSTS_PER_REQUEST);
    }

    return sitemap;
};

const buildAllSitemaps = async function buildAllSitemaps() {
    // State is local to each run so repeated (scheduled) invocations don't
    // accumulate the index or the counters across runs.
    let finished = 0;
    let failed = 0;
    const indexedGames = [];

    if ( !fs.existsSync( 'sitemap' ) ) {
        fs.mkdirSync( 'sitemap' );
    }

    fs.readdirSync('sitemap').forEach(f => {
        if(f === '.gitignore'){
            return true;
        }
        fs.rmSync(`sitemap/${f}`);
    });

    console.time(`build-sitemaps`);
    let games = await getGames();
    let allGameSitemaps = [];

    games = shuffle(games);

    for ( const game of games ) {
        indexedGames.push(game.identifier);

        const sitemapPromise = limit(() => {
            console.time(`build-sitemap-${game.identifier}`);
            let gameSitemap = addPath(sitemapTemplate, `/${ game.identifier }/`);
            return buildSitemap(gameSitemap, game.identifier)
                .then((sitemap) => {
                    console.timeEnd(`build-sitemap-${game.identifier}`);
                    if(!sitemap){
                        console.log(`Failed to build complete sitemap for ${game.identifier}`);

                        failed = failed + 1;

                        return false;
                    }

                    sitemap = `${sitemap}
</urlset>`;

                    fs.writeFileSync(`sitemap/sitemap.${game.identifier}.xml`, sitemap);

                    finished = finished + 1;

                    return uploadXML(`sitemap.${game.identifier}.xml`);
                });
        });

        allGameSitemaps.push(sitemapPromise);
    }

    console.log('Waiting for all sitemaps to finish');
    await Promise.all(allGameSitemaps);

    const sitemapIndex = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${indexedGames.map((identifier) => {
        return `
    <sitemap>
        <loc>https://developertracker.com/sitemap.${identifier}.xml</loc>
    </sitemap>`;
    }).join('')}
</sitemapindex>`;

    fs.writeFileSync(`sitemap/sitemap.xml`, sitemapIndex);
    await uploadXML('sitemap.xml');

    console.timeEnd(`build-sitemaps`);
    console.log(`Done with ${finished}/${finished + failed} successfull sitemaps`);
};

module.exports = buildAllSitemaps;

// Allow running standalone: `node sitemap.js`
if ( require.main === module ) {
    buildAllSitemaps().catch( ( sitemapError ) => {
        console.error( sitemapError );

        process.exit( 1 );
    } );
}
