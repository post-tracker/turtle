const fs = require('node:fs');

const AWS = require( 'aws-sdk' );
const pLimit = require('p-limit');

require( 'dotenv' ).config();

const limit = pLimit(5);

const POSTS_PER_REQUEST = 1000;

if ( !process.env.API_TOKEN ) {
    throw new Error( 'Unable to load api key' );
}

if ( !process.env.AWS_ACCESS_KEY || !process.env.AWS_SECRET_KEY ) {
    throw new Error( 'AWS auth not configured' );
}

const API_HOST = 'api2.developertracker.com';
const S3_BUCKET = 'developer-tracker';

const s3 = new AWS.S3( {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_KEY,
} );

let sitemapIndex = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

const sitemapTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

let finished = 0;
let failed = 0;

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

const addSitemap = (identifier) => {
    sitemapIndex = `${sitemapIndex}
    <sitemap>
        <loc>https://developertracker.com/sitemap.${identifier}.xml</loc>
    </sitemap>`;
};

const addPath = (sitemap, url, changefreq = 'hourly') => {
    return `${sitemap}
    <url>
        <loc>https://developertracker.com${url}</loc>
        <changefreq>${changefreq}</changefreq>
    </url>`;
};

const uploadXML = (filename) => {
    const params = {
        Bucket: S3_BUCKET,
        Key: `${filename}`,
        Body: fs.readFileSync(`./sitemap/${filename}`, 'utf-8'),
        CacheControl: 'public, max-age=600',
        ContentType: 'application/xml',
    };

    s3.putObject( params, ( uploadError, data ) => {
        if ( uploadError ) {
            console.error( uploadError )
        } else {
            console.log( `Successfully uploaded sitemap ${filename}` );
        }
    } );
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
    let postsDataResponse;
    
    try {
        postsDataResponse = await fetch( `https://${API_HOST}/${ gameIdentifier }/posts?limit=${POSTS_PER_REQUEST}&offset=${offset}` );
        posts = await postsDataResponse.json();
    } catch ( parseFail ) {
        console.error( `Failed to parse posts for ${ gameIdentifier }` );

        // console.error(parseFail);
        // console.log(postsDataResponse);

        return false;
    }

    for ( const post of posts.data ) {
        sitemap = addPath(sitemap, `/${ gameIdentifier }/?post=${post.id}`, 'never');
    }

    if(posts.data.length >= POSTS_PER_REQUEST){
        sitemap = await buildSitemap(sitemap, gameIdentifier, offset + POSTS_PER_REQUEST);
    }

    return sitemap;
};

(async () => {
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
        addSitemap(game.identifier);
        
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
                    uploadXML(`sitemap.${game.identifier}.xml`);

                    finished = finished + 1;
                });
        });

        allGameSitemaps.push(sitemapPromise);
    }
    
    console.log('Waiting for all sitemaps to finish');
    await Promise.all(allGameSitemaps);

    sitemapIndex = `${sitemapIndex}
</sitemapindex>`;

    fs.writeFileSync(`sitemap/sitemap.xml`, sitemapIndex);
    uploadXML('sitemap.xml');
    
    console.timeEnd(`build-sitemaps`);
    console.log(`Done with ${finished}/${finished + failed} successfull sitemaps`);
})();

