const highland = require('highland')
const request = require('request')
const retryMe = require('retry-me')
const cheerio = require('cheerio')
const fs = require('fs')
const csvWriter = require('csv-write-stream')

const http = highland.wrapCallback((location, callback) => {
    const wrapper = location => {
        return callbackInner => {
            request.defaults({ timeout: 30 * 1000 })(location, (error, response) => {
                const failure = error ? error : (response.statusCode >= 400 && response.statusCode !== 404) ? new Error(response.statusCode + ': ' + response.request.href) : null
                console.log('Requested: ' + location + ' (' + (response ? response.statusCode : 'no response') + ')')
                callbackInner(failure, response)
            })
        }
    }
    retryMe(wrapper(location), { factor: 1.5 }, callback)
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
    return keys.map(key => 'http://www.publications.parliament.uk/pa/cm/cmregmem/' + key + '/part1contents.htm')
}

function members(response) {
    const document = cheerio.load(response.body)
    return document('td > p > a[href$=htm], #mainTextBlock > p > a[href$=htm]').not('[href="introduction.htm"]').get().map(entry => {
        return response.request.href.replace('part1contents.htm', '') + cheerio(entry).attr('href')
    })
}

function contents(response) {
    const document = cheerio.load(response.body)
    if (document('td p').text().indexOf('Nil') >= 0) return []
    const name = document('h2').text().trim().split(' (')[0]
    const edition = response.request.href.split('/')[6]
    const headings = document('td > h3, td > strong, td > p:has(strong), #mainTextBlock > h3, td > strong, #mainTextBlock > p:has(strong)').get().filter(heading => {
        return cheerio(heading).text().trim().match(/^\d{1,2}\./) // filter out those that look like a heading but aren't
    })
    return headings.map((heading, i) => {
        const nextHeading = i === headings.length ? 'div' : headings[i + 1] // if this heading is the last, look for a <div> signifying the end
        const items = cheerio(heading).nextUntil(nextHeading).get().reduce((a, item) => {
            const block = cheerio(item)
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
            const registeredMatch = item.match(/\(Registered (.*?)\)/)
            return {
                name: name,
                editionDeclared: edition,
                editionLastSeen: edition,
                section: cheerio(heading).text().trim(),
                item: item,
                amount: amountMatch ? amountMatch[0] : '',
                registered: registeredMatch ? new Date(registeredMatch[1]).toISOString().substr(0, 10) : ''
            }
        })
    })
}

function valid(text) {
    return text !== ''
        && text !== '.'
        && !text.match(/^(Previous[\s\S]*Contents|Contents[\s\S]*Next)/)
        && !text.match(/^(Donations to my constituency|Donations to the constituency|Donations to support|Support in the capacity as|Payments recieved in my capacity as|Other donations|Other support)/i)
}

var data = []

function dedupe(row) {
    const exists = data.find(existing => existing.name === row.name && existing.item === row.item && existing.editionDeclared !== row.editionDeclared)
    if (exists) exists.editionLastSeen = row.editionLastSeen
    else data.push(row)
}

highland(locations())
    .flatMap(http)
    .errors((e, push) => !e.message.startsWith('404') ? push(e) : null)
    .flatMap(members)
    .flatMap(http)
    .flatMap(contents)
    .flatten()
    .map(dedupe)
    .errors(e => console.log(e.stack))
    .done(() => {
        highland(data)
            .through(csvWriter())
            .pipe(fs.createWriteStream('members-financial-interests.csv'))
    })
