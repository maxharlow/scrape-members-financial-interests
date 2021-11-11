import Crypto from 'crypto'
import FSExtra from 'fs-extra'
import Axios from 'axios'
import AxiosRetry from 'axios-retry'
import Scramjet from 'scramjet'
import Cheerio from 'cheerio'
import HTMLToText from 'html-to-text'

async function request(location) {
    const url = typeof location === 'object' ? location.url : location
    const hash = Crypto.createHash('sha1').update(url).digest('hex')
    const isCached = await FSExtra.pathExists(`cache/${hash}`)
    if (isCached) {
        console.log(`Cached: ${url}...`)
        const cache = await FSExtra.readFile(`cache/${hash}`)
        return {
            url,
            data: JSON.parse(cache),
            passthrough: location.passthrough
        }
    }
    console.log(`Requesting: ${url}...`)
    const timeout = 30 * 1000
    const instance = Axios.create({ timeout })
    AxiosRetry(instance, {
        retries: 10,
        shouldResetTimeout: true,
        retryCondition: e => {
            return !e.response || e.response.status >= 500 // no response or server error
        },
        retryDelay: (number, e) => {
            if (number === 1) console.log(`Received ${(e.response && e.response.status) || e.code}: ${e.config.url}`)
            else console.log(`  → Received ${e.response.status || e.code} in retry attempt #${number - 1}: ${e.config.url}`)
            return 5 * 1000
        }
    })
    const response = await instance(location)
    if (!response.data.includes('Page cannot be found')) { // as these should be 200s
        await FSExtra.ensureDir('cache')
        await FSExtra.writeJson(`cache/${hash}`, response.data)
    }
    return {
        url,
        data: response.data,
        passthrough: location.passthrough
    }
}

function range(from, to) {
    return [...Array(to - from + 1)].map((_, i) => from + i)
}

function locations() {
    const years = range(10, new Date().getFullYear() - 2000)
    const months = range(1, 12).map(n => n < 10 ? '0' + n: '' + n)
    const days = range(1, 31).map(n => n < 10 ? '0' + n: '' + n)
    const editions = years.map(year => months.map(month => days.map(day => year + month + day))).join(',').split(',').filter(edition => {
        const firstPossibleEntry = 100525 // state opening of the 2010-12 parliament
        const lastPossibleEntry = Number(new Date().toISOString().substr(2, 8).replace(/-/g, '')) // today
        const editionNumber = Number(edition)
        return editionNumber >= firstPossibleEntry && editionNumber <= lastPossibleEntry
    })
    return editions.map(edition => {
        const title = edition > 151214 ? 'contents' : 'part1contents' // title changed on this date
        const url = `http://www.publications.parliament.uk/pa/cm/cmregmem/${edition}/${title}.htm`
        return {
            url,
            passthrough: {
                url,
                edition
            }
        }
    })
}

function members(response) {
    const document = Cheerio.load(response.data)
    if (document('h1').text().trim() === 'Page cannot be found') return []
    console.log(`Processing register ${response.passthrough.edition}...`)
    return document('td > p > a[href$=htm], #mainTextBlock > p > a[href$=htm]').not('[href="introduction.htm"]').get().map(entry => {
        const base = response.passthrough.url.replace('part1contents.htm', '').replace('contents.htm', '')
        return {
            url: base + encodeURIComponent(Cheerio(entry).attr('href')),
            passthrough: {
                edition: response.passthrough.edition
            }
        }
    })
}

function text(html) {
    const options = {
        selectors: [
            { selector: 'a', options: { ignoreHref: true } },
            { selector: 'ul', options: { itemPrefix: ' ' } }
        ],
        wordwrap: false,
        preserveNewlines: true
    }
    return HTMLToText.convert(html, options).trim().replace(/^\((a|b|c)\)/, '').trim()
}

function valid(text) {
    return text !== ''
        && text !== '.'
        && !text.match(/^(Previous[\s\S]+Contents|Contents[\s\S]+Next)/)
        && !text.match(/^(Donations to my constituency|Donations to the constituency|Donations to support|Support in the capacity as|Payments recieved in my capacity as|Other donations|Other support)/i)
}

function contents(response) {
    const document = Cheerio.load(response.data)
    if (document('td p').text().indexOf('Nil') >= 0) return []
    const name = document('h2').text().trim().split(' (')[0]
    const headings = document('td > h3, td > strong, td > p:has(strong), #mainTextBlock > h3, td > strong, #mainTextBlock > p:has(strong)').get().filter(heading => {
        return Cheerio(heading).text().trim().match(/^\d{1,2}\./) // filter out those that look like a heading but aren't
    })
    return headings.flatMap((heading, i) => {
        const nextHeading = i === headings.length ? 'div' : headings[i + 1] // if this heading is the last, look for a <div> signifying the end
        const items = Cheerio(heading).nextUntil(nextHeading).get().reduce((a, item) => {
            const block = Cheerio(item)
            const blockText = text(block.html())
            if (!valid(blockText)) {
                return a
            }
            else if (blockText.match(/^(Address of |Amount of |Value of |if donation in kind:|Date of receipt|Date of acceptance|Date the loan was entered into|Loan entered into|Date the loan is due to be repaid|Repayment|Donor status|Rate of interest|Whether or not any security has been given|Security offered|No security given|\(Registered|Date of visit|Destination of visit|Destination: |Purpose of visit|\d{1,2}\)|\(\d{1,2}\)|\d{1,2}\.)|(overdraft limit)/i)) {
                a[a.length - 1] += '\n' + blockText
                return a
            }
            else if (block.attr('class') === 'indent2') {
                const parent = document(item).prevUntil(heading, '.indent').first().text().trim()
                if (parent === '' || !valid(parent)) return a.concat(blockText) // ignore incorrect indentation
                const parentEntry = a.find(entry => entry === parent)
                if (parentEntry) a.splice(a.indexOf(a.find(e => e === parent)), 1)
                return a.concat(parent + '\n' + blockText)
            }
            else return a.concat(blockText)
        }, [])
        return items.map(item => {
            const timeHours = item.match(/[0-9]*\.?[0-9]+ ?ho?u?rs?/i)?.[0]
            const timeMinutes = item.match(/[0-9]+ ?minu?t?e?s?/i)?.[0]
            return {
                name,
                editionDeclared: response.passthrough.edition,
                editionLastSeen: response.passthrough.edition,
                section: Cheerio(heading).text().trim(),
                item,
                amount: item.match(/£\d+(,\d{3})*(\.\d{2})?/)?.[0],
                time: [timeHours, timeMinutes].join(' '),
                registered: item.match(/\((:?Registered)?(:? )*(\d{1,2} \S+ \d{4})/)?.[0],
            }
        })
    })
}

function dedupe(a, row) {
    const current = a.find(existing => existing.name === row.name && existing.item === row.item && existing.editionDeclared !== row.editionDeclared)
    if (current) {
        current.editionLastSeen = row.editionLastSeen
        return a
    }
    else return a.concat(row)
}

function alphachronological(a, b) {
    if (a.name.toLowerCase() < b.name.toLowerCase()) return -1
    if (a.name.toLowerCase() > b.name.toLowerCase()) return  1
    if (a.editionDeclared < b.editionDeclared) return -1
    if (a.editionDeclared > b.editionDeclared) return  1
    if (a.text < b.text) return -1
    if (a.text > b.text) return  1
    return 0
}

async function run() {
    const all = await Scramjet.DataStream.from(locations())
        .map(request)
        .flatMap(members)
        .map(request)
        .flatMap(contents)
        .reduce(dedupe, [])
    const sorted = all.sort(alphachronological)
    await Scramjet.DataStream.from(sorted)
        .CSVStringify()
        .pipe(FSExtra.createWriteStream('members-financial-interests.csv'))
}

run()
