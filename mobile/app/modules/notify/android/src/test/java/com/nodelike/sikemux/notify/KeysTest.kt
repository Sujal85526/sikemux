package com.nodelike.sikemux.notify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class KeysTest {
  @Test
  fun readsBackTheEntryItStored() {
    assertEquals(Pair(4_294_967_295L, "AAEC+/=="), Keys.parseEntry(Keys.entry(4_294_967_295L, "AAEC+/==")))
  }

  @Test
  fun ignoresAnEntryItDidNotWrite() {
    assertNull(Keys.parseEntry("no separator"))
    assertNull(Keys.parseEntry("seven:AAEC"))
    assertNull(Keys.parseEntry("7:"))
    assertNull(Keys.parseEntry(""))
  }
}
