Scrape Member's Financial Interests
===================================

Parliament [publishes](http://www.publications.parliament.uk/pa/cm/cmregmem.htm) the register of member's financial interests, which aims to 'provide information about any financial interest which a Member has, or any benefit which he or she receives, which others might reasonably consider to influence his or her actions or words as a Member of Parliament'.

This scrapes the register into a CSV. Since the data is published as a series of documents, this tries to bring some structure to the data, but sometimes this will be incorrect. It's probably not wise to use this as your sole source for anything important.

Install the dependencies with `npm install`, then run `node members-financial-interests`. Produces a file named `members-financial-interests.csv`.
