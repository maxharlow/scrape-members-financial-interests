const Highland = require('highland')
const Request = require('request')
const RetryMe = require('retry-me')
const Cheerio = require('cheerio')
const FS = require('fs')
const CSVWriter = require('csv-write-stream')

const http = Highland.wrapCallback((location, callback) => {
    const wrapper = location => {
        return callbackInner => {
            Request.defaults({ timeout: 30 * 1000 })(location, (error, response) => {
                const failure = error ? error : response.statusCode >= 400 ? new Error(response.statusCode + ' for ' + response.request.href) : null
                callbackInner(failure, response)
            })
        }
    }
    RetryMe(wrapper(location), { factor: 1.5 }, callback)
})

function range(from, to) {
    return [...Array(to - from + 1)].map((_, i) => from + i)
}

function locations() {
    const years = range(10, new Date().getFullYear() - 2000)
    const months = range(1, 12).map(n => n < 10 ? '0' + n: '' + n)
    const days = range(1, 31).map(n => n < 10 ? '0' + n: '' + n)
    const keys = years.map(year => months.map(month => days.map(day => year + month + day))).join(',').split(',').filter(key => {
        const firstPossibleEntry = 100525 // state opening of the 2010-12 parliament
        const lastPossibleEntry = Number(new Date().toISOString().substr(2, 8).replace(/-/g, '')) // today
        const keyNumber = Number(key)
        return keyNumber >= firstPossibleEntry && keyNumber <= lastPossibleEntry
    })
    return keys.map(key => {
        const title = key > 151214 ? 'contents' : 'part1contents' // title changed on this date
        return `http://www.publications.parliament.uk/pa/cm/cmregmem/${key}/${title}.htm`
    })
}

function members(response) {
    const document = Cheerio.load(response.body)
    if (document('h1').text().trim() === 'Page cannot be found') return []
    console.log('Processing register ' + response.request.href.split('/')[6] + '...')
    return document('td > p > a[href$=htm], #mainTextBlock > p > a[href$=htm]').not('[href="introduction.htm"]').get().map(entry => {
        const base = response.request.href.replace('part1contents.htm', '').replace('contents.htm', '')
        return base + Cheerio(entry).attr('href')
    })
}

function contents(response) {
    const document = Cheerio.load(response.body)
    if (document('td p').text().indexOf('Nil') >= 0) return []
    const name = document('h2').text().trim().split(' (')[0]
    const edition = response.request.href.split('/')[6]
    const headings = document('td > h3, td > strong, td > p:has(strong), #mainTextBlock > h3, td > strong, #mainTextBlock > p:has(strong)').get().filter(heading => {
        return Cheerio(heading).text().trim().match(/^\d{1,2}\./) // filter out those that look like a heading but aren't
    })
    return headings.map((heading, i) => {
        const nextHeading = i === headings.length ? 'div' : headings[i + 1] // if this heading is the last, look for a <div> signifying the end
        const items = Cheerio(heading).nextUntil(nextHeading).get().reduce((a, item) => {
            const block = Cheerio(item)
            const blockText = block.text().trim().replace(/^\((a|b|c)\)/, '').trim()
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
            const amountMatch = item.match(/£\d+(,\d{3})*(\.\d{2})?/)
            const registeredMatch = item.match(/\((:?Registered)?(:? )*(\d{1,2} \S+ \d{4})/)
            return {
                name,
                editionDeclared: edition,
                editionLastSeen: edition,
                section: Cheerio(heading).text().trim(),
                item,
                amount: amountMatch ? amountMatch[0] : '',
                registered: registeredMatch ? new Date(registeredMatch[3]).toISOString().substr(0, 10) : ''
            }
        })
    })
}

function valid(text) {
    return text !== ''
        && text !== '.'
        && !text.match(/^(Previous[\s\S]+Contents|Contents[\s\S]+Next)/)
        && !text.match(/^(Donations to my constituency|Donations to the constituency|Donations to support|Support in the capacity as|Payments recieved in my capacity as|Other donations|Other support)/i)
}

var data = []

function dedupe(row) {
    const exists = data.find(existing => existing.name === row.name && existing.item === row.item && existing.editionDeclared !== row.editionDeclared)
    if (exists) exists.editionLastSeen = row.editionLastSeen
    else data.push(row)
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

Highland(locations())
    .flatMap(http)
    .flatMap(members)
    .flatMap(http)
    .flatMap(contents)
    .flatten()
    .map(dedupe)
    .errors(e => console.error(e.stack))
    .done(() => {
        console.log('Sorting...')
        Highland(data)
            .sortBy(alphachronological)
            .through(CSVWriter())
            .pipe(FS.createWriteStream('members-financial-interests.csv'))
    })
