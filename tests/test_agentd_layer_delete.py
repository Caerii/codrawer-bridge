import asyncio

from codrawer_bridge.agentd.queue import PageQueue


def test_layer_deletion_cancels_only_that_pages_answers():
    async def run():
        q = PageQueue()
        started = asyncio.Event()
        canceled = asyncio.Event()
        other_done = []
        async def pending():
            started.set()
            try:
                await asyncio.sleep(100)
            finally:
                canceled.set()
        async def other():
            other_done.append(True)
        q.submit('doc/page|selection', pending)
        await started.wait()
        q.submit('doc/other|selection', other)
        q.cancel_page('doc', 'page')
        await asyncio.wait_for(canceled.wait(), 1)
        await asyncio.sleep(0)
        assert other_done == [True]
        assert q.pending('doc/page|selection') == 0
    asyncio.run(run())
